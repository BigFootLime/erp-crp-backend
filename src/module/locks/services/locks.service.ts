import { repoAcquireLock, repoGetActiveLock, repoReleaseLock } from "../repository/locks.repository";
import type { EntityLock } from "../types/locks.types";

export type LockAttemptResult =
  | { ok: true; lock: EntityLock }
  | { ok: false; lock: EntityLock };

export async function svcAcquireLock(params: {
  entity_type: string;
  entity_id: string;
  user_id: number;
  reason?: string | null;
}): Promise<LockAttemptResult> {
  const r = await repoAcquireLock(params);
  if (r.acquired && r.lock) return { ok: true, lock: r.lock };

  const lock = r.lock ?? (await repoGetActiveLock(params.entity_type, params.entity_id));
  if (!lock) {
    // No active lock found (race/expired) -> retry once.
    const r2 = await repoAcquireLock(params);
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
  const released = await repoReleaseLock(params);
  if (released) return { ok: true };

  const active = await repoGetActiveLock(params.entity_type, params.entity_id);
  if (active && active.lockedBy.id !== params.user_id) return { ok: false, lock: active };
  return { ok: true };
}
