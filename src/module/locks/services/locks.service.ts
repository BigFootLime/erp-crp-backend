import { resolveAccessProfile } from "../../access-control/services/access-control.service";
import {
  moduleForRealtimeEntity,
  normalizeClientRealtimeSubscription,
  realtimeAccessProfileAllowsModule,
} from "../../../shared/realtime/realtime-room-policy";
import { HttpError } from "../../../utils/httpError";
import {
  repoAcquireLock,
  repoExpireLocks,
  repoGetActiveLock,
  repoReleaseLock,
  type LockableEntityType,
} from "../repository/locks.repository";
import type { EntityLock } from "../types/locks.types";

export type LockAttemptResult =
  | { ok: true; lock: EntityLock }
  | { ok: false; lock: EntityLock };

type AuthorizedLockEntity = { entityType: LockableEntityType; entityId: string };

const LOCKABLE_ENTITY_TYPES = new Set<LockableEntityType>([
  "COMMANDE_CLIENT",
  "OF",
  "PIECE_TECHNIQUE",
]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BIGINT_ID = 9_223_372_036_854_775_807n;

function normalizeLockEntity(entityType: string, entityId: string): AuthorizedLockEntity | null {
  const subscription = normalizeClientRealtimeSubscription({
    scope: "entity",
    entityType,
    entityId,
  });
  if (!subscription || subscription.scope !== "entity") return null;
  if (!LOCKABLE_ENTITY_TYPES.has(subscription.entityType as LockableEntityType)) return null;
  if (subscription.entityType === "PIECE_TECHNIQUE") {
    return UUID_RE.test(subscription.entityId)
      ? { entityType: "PIECE_TECHNIQUE", entityId: subscription.entityId.toLowerCase() }
      : null;
  }
  if (!/^\d{1,19}$/.test(subscription.entityId)) return null;
  const numericId = BigInt(subscription.entityId);
  if (numericId < 1n || numericId > MAX_BIGINT_ID) return null;
  return {
    entityType: subscription.entityType as "COMMANDE_CLIENT" | "OF",
    entityId: numericId.toString(),
  };
}

async function authorizeLockEntity(params: {
  entity_type: string;
  entity_id: string;
  user_id: number;
}): Promise<AuthorizedLockEntity> {
  const entity = normalizeLockEntity(params.entity_type, params.entity_id);
  if (!entity) {
    throw new HttpError(400, "INVALID_LOCK_ENTITY", "Ressource de verrouillage invalide");
  }
  const moduleKey = moduleForRealtimeEntity(entity.entityType);
  if (!moduleKey) {
    throw new HttpError(400, "INVALID_LOCK_ENTITY", "Ressource de verrouillage invalide");
  }
  let profile: Awaited<ReturnType<typeof resolveAccessProfile>>;
  try {
    profile = await resolveAccessProfile(params.user_id);
  } catch {
    throw new HttpError(503, "LOCK_AUTHORIZATION_UNAVAILABLE", "Autorisation indisponible");
  }
  if (profile === null) {
    throw new HttpError(503, "LOCK_AUTHORIZATION_UNAVAILABLE", "Autorisation indisponible");
  }
  if (!realtimeAccessProfileAllowsModule(profile, moduleKey)) {
    // Deliberately does not reveal the module, entity existence or lock owner.
    throw new HttpError(403, "FORBIDDEN", "Accès interdit");
  }
  return entity;
}

export async function svcAcquireLock(params: {
  entity_type: string;
  entity_id: string;
  user_id: number;
  reason?: string | null;
}): Promise<LockAttemptResult> {
  const entity = await authorizeLockEntity(params);
  const canonicalParams = {
    ...params,
    entity_type: entity.entityType,
    entity_id: entity.entityId,
  };
  const r = await repoAcquireLock(canonicalParams);
  if (!r.entityExists) {
    throw new HttpError(404, "LOCK_ENTITY_NOT_FOUND", "Ressource introuvable");
  }
  if (r.acquired && r.lock) return { ok: true, lock: r.lock };

  const lock = r.lock ?? (await repoGetActiveLock(entity.entityType, entity.entityId));
  if (!lock) {
    // No active lock found (race/expired) -> retry once.
    const r2 = await repoAcquireLock(canonicalParams);
    if (!r2.entityExists) {
      throw new HttpError(404, "LOCK_ENTITY_NOT_FOUND", "Ressource introuvable");
    }
    if (r2.lock) return { ok: Boolean(r2.acquired), lock: r2.lock };
    throw new Error("Failed to acquire lock");
  }

  if (lock.lockedBy.id === params.user_id) return { ok: true, lock };
  return { ok: false, lock };
}

export async function svcHeartbeatLock(params: {
  entity_type: string;
  entity_id: string;
  user_id: number;
}): Promise<LockAttemptResult> {
  return svcAcquireLock({ ...params, reason: null });
}

export async function svcReleaseLock(params: {
  entity_type: string;
  entity_id: string;
  user_id: number;
}): Promise<{ ok: true } | { ok: false; lock: EntityLock }> {
  const entity = await authorizeLockEntity(params);
  const result = await repoReleaseLock({
    ...params,
    entity_type: entity.entityType,
    entity_id: entity.entityId,
  });
  if (!result.entityExists) {
    throw new HttpError(404, "LOCK_ENTITY_NOT_FOUND", "Ressource introuvable");
  }
  if (result.released) return { ok: true };

  const active = await repoGetActiveLock(entity.entityType, entity.entityId);
  if (active && active.lockedBy.id !== params.user_id) return { ok: false, lock: active };
  return { ok: true };
}

const DEFAULT_EXPIRED_LOCK_SWEEP_MS = 5_000;
const EXPIRED_LOCK_SWEEP_BATCH = 500;

function expiredLockSweepIntervalMs(): number {
  const parsed = Number.parseInt(process.env.LOCK_EXPIRY_SWEEP_MS ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed >= 1_000 ? parsed : DEFAULT_EXPIRED_LOCK_SWEEP_MS;
}

/** Starts the server-owned expiry path; safe on multi-instance deployments. */
export function startExpiredLockMaintenance(): () => void {
  let stopped = false;
  let running = false;
  const sweep = async () => {
    if (stopped || running) return;
    running = true;
    try {
      let expired: number;
      do {
        expired = await repoExpireLocks(EXPIRED_LOCK_SWEEP_BATCH);
      } while (!stopped && expired === EXPIRED_LOCK_SWEEP_BATCH);
    } catch (error) {
      console.warn(JSON.stringify({
        type: "entity_lock_expiry_sweep_failed",
        error: error instanceof Error ? error.name : "unknown",
      }));
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void sweep(), expiredLockSweepIntervalMs());
  timer.unref();
  void sweep();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
