// src/module/access-control/services/access-control.service.ts
import { HttpError } from "../../../utils/httpError";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import * as repo from "../repository/access-control.repository";
import type { CatalogModuleRow, DbQueryer } from "../repository/access-control.repository";
import type {
  AccessAuditContext,
  AccessOverview,
  ModuleAccessDecision,
  ModuleAccessOverride,
  ModuleAccessSource,
  OverviewMatrixCell,
  ResolvedAccessProfile,
  ResolvedModuleAccess,
} from "../types/access-control.types";

const AUDIT_PAGE_KEY = "administration-acces";
const AUDIT_ENTITY_TYPE = "module_access";
const UNLOCK_ALL_CONFIRMATION = "DEBLOQUER TOUT";

/** Durée de vie du cache de résolution, en millisecondes. */
export const ACCESS_CACHE_TTL_MS = 10_000;

type CacheEntry = { expiresAt: number; profile: ResolvedAccessProfile };

// Cache PROCESSUS : chaque instance API garde le sien. Une mutation invalide
// immédiatement le sien ; les autres instances convergent au plus tard au bout du TTL.
const profileCache = new Map<number, CacheEntry>();

export function invalidateAccessCache(userId?: number): void {
  if (typeof userId === "number") {
    profileCache.delete(userId);
    return;
  }
  profileCache.clear();
}

/** Décision d'accès pour une ligne de catalogue déjà résolue. */
function decide(params: {
  isSuperadmin: boolean;
  isActive: boolean;
  isProtected: boolean;
  override: ModuleAccessOverride | null;
}): { allowed: boolean; source: ModuleAccessSource } {
  if (params.isSuperadmin) return { allowed: true, source: "SUPERADMIN" };
  if (params.isProtected) return { allowed: true, source: "DEFAULT" };
  if (!params.isActive) return { allowed: false, source: "DEFAULT" };
  if (params.override === "DENIED") return { allowed: false, source: "OVERRIDE" };
  return { allowed: true, source: params.override === "GRANTED" ? "OVERRIDE" : "DEFAULT" };
}

/**
 * Profil d'accès d'un compte. `null` signifie « infrastructure d'accès absente »
 * (42P01) : l'appelant décide alors de laisser passer, il ne reçoit pas un refus.
 */
export async function resolveAccessProfile(userId: number): Promise<ResolvedAccessProfile | null> {
  const cached = profileCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.profile;

  const rows = await repo.repoResolveAccessProfile(userId);
  if (rows === null) return null;

  const isSuperadmin = rows[0]?.is_superadmin === true;
  const modules: ResolvedModuleAccess[] = [];
  for (const row of rows) {
    if (!row.module_key) continue;
    const { allowed, source } = decide({
      isSuperadmin,
      isActive: row.is_active !== false,
      isProtected: row.is_protected === true,
      override: row.access,
    });
    modules.push({
      module_key: row.module_key,
      label: row.label ?? row.module_key,
      nav_page_keys: row.nav_page_keys ?? [],
      allowed,
      source,
    });
  }

  const profile: ResolvedAccessProfile = { is_superadmin: isSuperadmin, modules };
  profileCache.set(userId, { expiresAt: Date.now() + ACCESS_CACHE_TTL_MS, profile });
  return profile;
}

/** Réponse de `GET /auth/access-profile`. Infrastructure absente ⇒ aucun filtrage. */
export async function getAccessProfile(userId: number): Promise<ResolvedAccessProfile> {
  const profile = await resolveAccessProfile(userId);
  return profile ?? { is_superadmin: false, modules: [] };
}

export async function isSuperadmin(userId: number): Promise<boolean> {
  return repo.repoIsSuperadmin(userId);
}

export async function buildOverview(tx?: DbQueryer): Promise<AccessOverview> {
  const [modules, users, overrides] = await Promise.all([
    repo.repoListCatalogModules(tx),
    repo.repoListAccessUsers(tx),
    repo.repoListAccessOverrides(tx),
  ]);

  const overrideByUser = new Map<number, Map<string, ModuleAccessOverride>>();
  for (const row of overrides) {
    let byModule = overrideByUser.get(row.user_id);
    if (!byModule) {
      byModule = new Map<string, ModuleAccessOverride>();
      overrideByUser.set(row.user_id, byModule);
    }
    byModule.set(row.module_key, row.access);
  }

  const activeModules = modules.filter((module) => module.is_active);
  const matrix: OverviewMatrixCell[] = [];
  const userCounters = new Map<number, { denied: number; allowed: number }>();

  for (const user of users) {
    const byModule = overrideByUser.get(user.id);
    const counters = { denied: 0, allowed: 0 };
    for (const module of activeModules) {
      const override = byModule?.get(module.module_key) ?? null;
      const { allowed, source } = decide({
        isSuperadmin: user.is_superadmin,
        isActive: module.is_active,
        isProtected: module.is_protected,
        override,
      });
      matrix.push({ user_id: user.id, module_key: module.module_key, access: override, effective: allowed, source });
      if (allowed) counters.allowed += 1;
      if (override === "DENIED") counters.denied += 1;
    }
    userCounters.set(user.id, counters);
  }

  const deniedByModule = new Map<string, number>();
  const grantedByModule = new Map<string, number>();
  for (const row of overrides) {
    const target = row.access === "DENIED" ? deniedByModule : grantedByModule;
    target.set(row.module_key, (target.get(row.module_key) ?? 0) + 1);
  }

  return {
    modules: modules.map((module) => ({
      module_key: module.module_key,
      label: module.label,
      description: module.description,
      category: module.category,
      enabled_by_default: module.enabled_by_default,
      is_protected: module.is_protected,
      sort_order: module.sort_order,
      denied_count: deniedByModule.get(module.module_key) ?? 0,
      granted_count: grantedByModule.get(module.module_key) ?? 0,
    })),
    users: users.map((user) => ({
      id: user.id,
      username: user.username,
      name: user.name,
      surname: user.surname,
      email: user.email,
      role: user.role,
      roles: user.roles,
      status: user.status,
      is_superadmin: user.is_superadmin,
      last_login: user.last_login,
      denied_count: userCounters.get(user.id)?.denied ?? 0,
      allowed_count: userCounters.get(user.id)?.allowed ?? 0,
    })),
    matrix,
    summary: {
      users_total: users.length,
      superadmins: users.filter((user) => user.is_superadmin).length,
      modules_total: modules.length,
      modules_restricted_by_default: modules.filter((module) => !module.enabled_by_default).length,
      active_restrictions: overrides.filter((row) => row.access === "DENIED").length,
    },
  };
}

async function writeAuditLog(
  tx: DbQueryer,
  audit: AccessAuditContext,
  entry: { action: string; entityId: string; details: Record<string, unknown> }
): Promise<void> {
  await repoInsertAuditLog({
    user_id: audit.user_id,
    body: {
      event_type: "ACTION",
      action: entry.action,
      page_key: AUDIT_PAGE_KEY,
      entity_type: AUDIT_ENTITY_TYPE,
      entity_id: entry.entityId,
      path: audit.path,
      client_session_id: audit.client_session_id,
      details: entry.details,
    },
    ip: audit.ip,
    user_agent: audit.user_agent,
    device_type: audit.device_type,
    os: audit.os,
    browser: audit.browser,
    tx,
  });
}

async function loadModuleOrThrow(tx: DbQueryer, moduleKey: string): Promise<CatalogModuleRow> {
  const module = await repo.repoGetCatalogModule(moduleKey, tx);
  if (!module) throw new HttpError(404, "MODULE_NOT_FOUND", "Module inconnu.");
  return module;
}

export async function setModuleDefault(params: {
  moduleKey: string;
  enabled: boolean;
  audit: AccessAuditContext;
}): Promise<AccessOverview> {
  if (!params.enabled) {
    throw new HttpError(
      409,
      "ACCOUNT_ONLY_ACCESS_POLICY",
      "Le défaut global est toujours ouvert. Restreignez un compte sur un module."
    );
  }
  const overview = await repo.withTransaction(async (tx) => {
    const module = await loadModuleOrThrow(tx, params.moduleKey);
    if (module.is_protected && !params.enabled) {
      throw new HttpError(409, "MODULE_PROTECTED", "Ce module ne peut pas être restreint.");
    }
    if (module.enabled_by_default !== params.enabled) {
      await repo.repoSetModuleDefault(tx, { moduleKey: module.module_key, enabled: params.enabled });
      await repo.repoInsertAccessEvent(tx, {
        userId: null,
        moduleKey: module.module_key,
        eventType: "DEFAULT_CHANGED",
        previousState: module.enabled_by_default ? "ENABLED" : "DISABLED",
        nextState: params.enabled ? "ENABLED" : "DISABLED",
        actorUserId: params.audit.user_id,
      });
      await writeAuditLog(tx, params.audit, {
        action: "ACCESS_MODULE_DEFAULT_SET",
        entityId: module.module_key,
        details: {
          module_key: module.module_key,
          previous_state: module.enabled_by_default,
          next_state: params.enabled,
        },
      });
    }
    return buildOverview(tx);
  });

  // Un défaut catalogue change la résolution de TOUS les comptes sans override.
  invalidateAccessCache();
  return overview;
}

/** Applique une décision unitaire. Retourne `null` si l'état est déjà celui demandé. */
async function applyUserModuleDecision(
  tx: DbQueryer,
  params: {
    userId: number;
    module: CatalogModuleRow;
    decision: ModuleAccessDecision;
    actorUserId: number;
    targetIsSuperadmin: boolean;
  }
): Promise<{ previous: ModuleAccessOverride | null; next: ModuleAccessDecision } | null> {
  const decision: ModuleAccessDecision =
    params.decision === "GRANTED" ? "INHERIT" : params.decision;

  if (decision === "DENIED") {
    if (params.module.is_protected) {
      throw new HttpError(409, "MODULE_PROTECTED", "Ce module ne peut pas être restreint.");
    }
    if (params.targetIsSuperadmin) {
      throw new HttpError(409, "SUPERADMIN_IMMUTABLE", "Ce compte ne peut pas être restreint.");
    }
  }

  const previous = await repo.repoGetUserModuleAccess(params.userId, params.module.module_key, tx);
  if (decision === "INHERIT") {
    if (previous === null) return null;
    await repo.repoDeleteUserModuleAccess(tx, {
      userId: params.userId,
      moduleKey: params.module.module_key,
    });
  } else {
    if (previous === decision) return null;
    await repo.repoUpsertUserModuleAccess(tx, {
      userId: params.userId,
      moduleKey: params.module.module_key,
      access: decision,
      updatedBy: params.actorUserId,
    });
  }

  await repo.repoInsertAccessEvent(tx, {
    userId: params.userId,
    moduleKey: params.module.module_key,
    eventType: decision === "INHERIT" ? "INHERITED" : decision,
    previousState: previous ?? "INHERIT",
    nextState: decision,
    actorUserId: params.actorUserId,
  });

  return { previous, next: decision };
}

async function loadTargetUser(tx: DbQueryer, userId: number) {
  const user = await repo.repoGetAccessUser(userId, tx);
  if (!user) throw new HttpError(404, "USER_NOT_FOUND", "Utilisateur inconnu.");
  return user;
}

export async function setUserModuleAccess(params: {
  userId: number;
  moduleKey: string;
  decision: ModuleAccessDecision;
  audit: AccessAuditContext;
}): Promise<AccessOverview> {
  const overview = await repo.withTransaction(async (tx) => {
    const user = await loadTargetUser(tx, params.userId);
    const module = await loadModuleOrThrow(tx, params.moduleKey);
    const change = await applyUserModuleDecision(tx, {
      userId: user.id,
      module,
      decision: params.decision,
      actorUserId: params.audit.user_id,
      targetIsSuperadmin: user.is_superadmin,
    });
    if (change) {
      await writeAuditLog(tx, params.audit, {
        action: "ACCESS_USER_MODULE_SET",
        entityId: `${user.id}:${module.module_key}`,
        details: {
          user_id: user.id,
          username: user.username,
          module_key: module.module_key,
          previous_state: change.previous,
          next_state: change.next,
        },
      });
    }
    return buildOverview(tx);
  });

  invalidateAccessCache(params.userId);
  return overview;
}

export async function setUserModulesBulk(params: {
  userId: number;
  entries: ReadonlyArray<{ module_key: string; access: ModuleAccessDecision }>;
  audit: AccessAuditContext;
}): Promise<AccessOverview> {
  const overview = await repo.withTransaction(async (tx) => {
    const user = await loadTargetUser(tx, params.userId);
    const applied: Array<{ module_key: string; previous_state: string | null; next_state: string }> = [];

    for (const entry of params.entries) {
      const module = await loadModuleOrThrow(tx, entry.module_key);
      const change = await applyUserModuleDecision(tx, {
        userId: user.id,
        module,
        decision: entry.access,
        actorUserId: params.audit.user_id,
        targetIsSuperadmin: user.is_superadmin,
      });
      if (change) {
        applied.push({
          module_key: module.module_key,
          previous_state: change.previous,
          next_state: change.next,
        });
      }
    }

    if (applied.length > 0) {
      await writeAuditLog(tx, params.audit, {
        action: "ACCESS_USER_BULK_SET",
        entityId: String(user.id),
        details: { user_id: user.id, username: user.username, changes: applied },
      });
    }
    return buildOverview(tx);
  });

  invalidateAccessCache(params.userId);
  return overview;
}

export async function unlockAll(params: {
  confirm: string;
  audit: AccessAuditContext;
}): Promise<AccessOverview> {
  if (params.confirm !== UNLOCK_ALL_CONFIRMATION) {
    throw new HttpError(400, "CONFIRMATION_REQUIRED", "Confirmation exacte requise.");
  }

  const overview = await repo.withTransaction(async (tx) => {
    const removed = await repo.repoDeleteAllDenials(tx);
    const restored = await repo.repoRestoreAllDefaults(tx);

    for (const row of removed) {
      await repo.repoInsertAccessEvent(tx, {
        userId: row.user_id,
        moduleKey: row.module_key,
        eventType: "UNLOCK_ALL",
        previousState: "DENIED",
        nextState: "INHERIT",
        actorUserId: params.audit.user_id,
      });
    }
    for (const moduleKey of restored) {
      await repo.repoInsertAccessEvent(tx, {
        userId: null,
        moduleKey,
        eventType: "UNLOCK_ALL",
        previousState: "DISABLED",
        nextState: "ENABLED",
        actorUserId: params.audit.user_id,
      });
    }

    await writeAuditLog(tx, params.audit, {
      action: "ACCESS_UNLOCK_ALL",
      entityId: "*",
      details: {
        removed_denials: removed.length,
        restored_defaults: restored.length,
        modules_restored: restored,
      },
    });
    return buildOverview(tx);
  });

  invalidateAccessCache();
  return overview;
}

export async function listAccessEvents(filters: {
  limit: number;
  offset: number;
  user_id?: number;
  module_key?: string;
}) {
  return repo.repoListAccessEvents(filters);
}
