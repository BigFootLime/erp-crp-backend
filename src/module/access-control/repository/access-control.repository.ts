// src/module/access-control/repository/access-control.repository.ts
import type { PoolClient } from "pg";

import pool from "../../../config/database";
import { bumpRealtimeAuthorizationEpoch } from "../../../shared/realtime/realtime-control-plane";
import { withRealtimeOutboxTransaction } from "../../../shared/realtime/realtime-outbox-transaction";
import type {
  AccessEventRow,
  AccessEventType,
  AccessProfileRow,
  ModuleAccessOverride,
} from "../types/access-control.types";

export type DbQueryer = Pick<PoolClient, "query">;

export type CatalogModuleRow = {
  module_key: string;
  label: string;
  description: string | null;
  category: string;
  api_prefixes: string[];
  nav_page_keys: string[];
  enabled_by_default: boolean;
  is_protected: boolean;
  sort_order: number;
  is_active: boolean;
};

export type AccessUserRow = {
  id: number;
  username: string;
  name: string | null;
  surname: string | null;
  email: string | null;
  role: string;
  roles: string[];
  status: string | null;
  is_superadmin: boolean;
  last_login: string | null;
};

export type AccessOverrideRow = {
  user_id: number;
  module_key: string;
  access: ModuleAccessOverride;
};

/**
 * `42P01` (undefined_table) : le patch #326 n'est pas appliqué sur cette base.
 * Le socle le traite comme une absence d'infrastructure, jamais comme un refus.
 */
export function isUndefinedTable(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "42P01";
}

/** Shared revision incremented in the same transaction as every ACL mutation. */
export async function repoAuthorizationEpoch(tx?: DbQueryer): Promise<bigint | null> {
  const q = tx ?? pool;
  try {
    const { rows } = await q.query<{ epoch: string }>(
      "SELECT epoch::text FROM public.realtime_authorization_epoch WHERE singleton = true"
    );
    return rows[0] ? BigInt(rows[0].epoch) : null;
  } catch (err) {
    if (isUndefinedTable(err)) return null;
    throw err;
  }
}

export async function withTransaction<T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  return withRealtimeOutboxTransaction(client, fn);
}

/**
 * Une seule requête pour le profil complet d'un compte. Le départ depuis `users`
 * garantit une ligne même quand le catalogue est vide : le marqueur superadmin
 * reste lisible et le gate distingue « catalogue non peuplé » de « refus ».
 * Retourne `null` si l'infrastructure d'accès est absente (42P01).
 */
export async function repoResolveAccessProfile(
  userId: number,
  tx?: DbQueryer
): Promise<AccessProfileRow[] | null> {
  const q = tx ?? pool;
  try {
    const { rows } = await q.query<AccessProfileRow>(
      `
        SELECT
          COALESCE(u.is_superadmin, false) AS is_superadmin,
          m.module_key,
          m.label,
          m.nav_page_keys,
          m.enabled_by_default,
          m.is_protected,
          m.is_active,
          a.access
        FROM public.users u
        LEFT JOIN public.app_modules m ON true
        LEFT JOIN public.app_module_user_access a
          ON a.user_id = u.id
         AND a.module_key = m.module_key
        WHERE u.id = $1
        ORDER BY m.sort_order NULLS LAST, m.module_key NULLS LAST
      `,
      [userId]
    );
    return rows;
  } catch (err) {
    if (isUndefinedTable(err)) return null;
    throw err;
  }
}

export async function repoIsSuperadmin(userId: number, tx?: DbQueryer): Promise<boolean> {
  const q = tx ?? pool;
  const { rows } = await q.query<{ is_superadmin: boolean }>(
    `
      SELECT COALESCE(is_superadmin, false) AS is_superadmin
      FROM public.users
      WHERE id = $1
        AND status = 'Active'
      LIMIT 1
    `,
    [userId]
  );
  return rows[0]?.is_superadmin === true;
}

export async function repoListCatalogModules(tx?: DbQueryer): Promise<CatalogModuleRow[]> {
  const q = tx ?? pool;
  const { rows } = await q.query<CatalogModuleRow>(
    `
      SELECT
        module_key,
        label,
        description,
        category,
        api_prefixes,
        nav_page_keys,
        enabled_by_default,
        is_protected,
        sort_order,
        is_active
      FROM public.app_modules
      ORDER BY sort_order, module_key
    `
  );
  return rows;
}

export async function repoGetCatalogModule(
  moduleKey: string,
  tx?: DbQueryer
): Promise<CatalogModuleRow | null> {
  const q = tx ?? pool;
  const { rows } = await q.query<CatalogModuleRow>(
    `
      SELECT
        module_key,
        label,
        description,
        category,
        api_prefixes,
        nav_page_keys,
        enabled_by_default,
        is_protected,
        sort_order,
        is_active
      FROM public.app_modules
      WHERE module_key = $1
      LIMIT 1
    `,
    [moduleKey]
  );
  return rows[0] ?? null;
}

export async function repoListAccessUsers(tx?: DbQueryer): Promise<AccessUserRow[]> {
  const q = tx ?? pool;
  const { rows } = await q.query<AccessUserRow>(
    `
      SELECT
        u.id::int AS id,
        u.username,
        u.name,
        u.surname,
        u.email,
        u.role,
        COALESCE(
          array_agg(ura.role_key ORDER BY (ura.role_key = u.role) DESC, ura.role_key)
            FILTER (WHERE ura.role_key IS NOT NULL),
          ARRAY[u.role]::text[]
        ) AS roles,
        u.status,
        COALESCE(u.is_superadmin, false) AS is_superadmin,
        u.last_login::text AS last_login
      FROM public.users u
      LEFT JOIN public.user_role_assignments ura ON ura.user_id = u.id
      GROUP BY u.id
      ORDER BY u.username
    `
  );
  return rows;
}

export async function repoGetAccessUser(userId: number, tx?: DbQueryer): Promise<AccessUserRow | null> {
  const q = tx ?? pool;
  const { rows } = await q.query<AccessUserRow>(
    `
      SELECT
        u.id::int AS id,
        u.username,
        u.name,
        u.surname,
        u.email,
        u.role,
        COALESCE(
          (
            SELECT array_agg(ura.role_key ORDER BY (ura.role_key = u.role) DESC, ura.role_key)
            FROM public.user_role_assignments ura
            WHERE ura.user_id = u.id
          ),
          ARRAY[u.role]::text[]
        ) AS roles,
        u.status,
        COALESCE(u.is_superadmin, false) AS is_superadmin,
        u.last_login::text AS last_login
      FROM public.users u
      WHERE u.id = $1
      LIMIT 1
    `,
    [userId]
  );
  return rows[0] ?? null;
}

export async function repoListAccessOverrides(tx?: DbQueryer): Promise<AccessOverrideRow[]> {
  const q = tx ?? pool;
  const { rows } = await q.query<AccessOverrideRow>(
    `
      SELECT user_id::int AS user_id, module_key, access
      FROM public.app_module_user_access
      ORDER BY user_id, module_key
    `
  );
  return rows;
}

export async function repoGetUserModuleAccess(
  userId: number,
  moduleKey: string,
  tx?: DbQueryer
): Promise<ModuleAccessOverride | null> {
  const q = tx ?? pool;
  const { rows } = await q.query<{ access: ModuleAccessOverride }>(
    `
      SELECT access
      FROM public.app_module_user_access
      WHERE user_id = $1 AND module_key = $2
      LIMIT 1
    `,
    [userId, moduleKey]
  );
  return rows[0]?.access ?? null;
}

export async function repoSetModuleDefault(
  tx: DbQueryer,
  params: { moduleKey: string; enabled: boolean }
): Promise<boolean> {
  // `cerp_app` ne détient que UPDATE(enabled_by_default, updated_at) : le catalogue
  // lui-même reste hors de portée de l'API.
  const { rowCount } = await tx.query(
    `
      UPDATE public.app_modules
      SET enabled_by_default = $2, updated_at = now()
      WHERE module_key = $1
    `,
    [params.moduleKey, params.enabled]
  );
  const changed = (rowCount ?? 0) > 0;
  if (changed) await bumpRealtimeAuthorizationEpoch(tx);
  return changed;
}

export async function repoUpsertUserModuleAccess(
  tx: DbQueryer,
  params: {
    userId: number;
    moduleKey: string;
    access: ModuleAccessOverride;
    updatedBy: number | null;
  }
): Promise<void> {
  await tx.query(
    `
      INSERT INTO public.app_module_user_access (user_id, module_key, access, updated_at, updated_by)
      VALUES ($1, $2, $3, now(), $4)
      ON CONFLICT (user_id, module_key) DO UPDATE
      SET access = EXCLUDED.access,
          updated_at = now(),
          updated_by = EXCLUDED.updated_by
    `,
    [params.userId, params.moduleKey, params.access, params.updatedBy]
  );
  await bumpRealtimeAuthorizationEpoch(tx);
}

export async function repoDeleteUserModuleAccess(
  tx: DbQueryer,
  params: { userId: number; moduleKey: string }
): Promise<boolean> {
  const { rowCount } = await tx.query(
    `
      DELETE FROM public.app_module_user_access
      WHERE user_id = $1 AND module_key = $2
    `,
    [params.userId, params.moduleKey]
  );
  const changed = (rowCount ?? 0) > 0;
  if (changed) await bumpRealtimeAuthorizationEpoch(tx);
  return changed;
}

export async function repoDeleteAllDenials(
  tx: DbQueryer
): Promise<Array<{ user_id: number; module_key: string }>> {
  const { rows } = await tx.query<{ user_id: number; module_key: string }>(
    `
      DELETE FROM public.app_module_user_access
      WHERE access = 'DENIED'
      RETURNING user_id::int AS user_id, module_key
    `
  );
  if (rows.length > 0) await bumpRealtimeAuthorizationEpoch(tx);
  return rows;
}

export async function repoRestoreAllDefaults(tx: DbQueryer): Promise<string[]> {
  const { rows } = await tx.query<{ module_key: string }>(
    `
      UPDATE public.app_modules
      SET enabled_by_default = true, updated_at = now()
      WHERE enabled_by_default IS DISTINCT FROM true
      RETURNING module_key
    `
  );
  if (rows.length > 0) await bumpRealtimeAuthorizationEpoch(tx);
  return rows.map((row) => row.module_key);
}

export async function repoInsertAccessEvent(
  tx: DbQueryer,
  params: {
    userId: number | null;
    moduleKey: string;
    eventType: AccessEventType;
    previousState: string | null;
    nextState: string | null;
    actorUserId: number | null;
    source?: string;
  }
): Promise<void> {
  await tx.query(
    `
      INSERT INTO public.app_module_access_events (
        user_id, module_key, event_type, previous_state, next_state, actor_user_id, source
      ) VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 'admin'))
    `,
    [
      params.userId,
      params.moduleKey,
      params.eventType,
      params.previousState,
      params.nextState,
      params.actorUserId,
      params.source ?? null,
    ]
  );
}

export async function repoListAccessEvents(
  filters: {
    limit: number;
    offset: number;
    user_id?: number;
    module_key?: string;
  },
  tx?: DbQueryer
): Promise<{ items: AccessEventRow[]; total: number }> {
  const q = tx ?? pool;
  const where: string[] = [];
  const values: unknown[] = [];
  const push = (value: unknown) => {
    values.push(value);
    return `$${values.length}`;
  };

  if (typeof filters.user_id === "number") {
    where.push(`e.user_id = ${push(filters.user_id)}`);
  }
  if (filters.module_key) {
    where.push(`e.module_key = ${push(filters.module_key)}`);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const countRes = await q.query<{ total: number }>(
    `SELECT COUNT(*)::int AS total FROM public.app_module_access_events e ${whereSql}`,
    values
  );

  const dataRes = await q.query<AccessEventRow>(
    `
      SELECT
        e.id::text AS id,
        e.user_id::int AS user_id,
        target.username AS username,
        e.module_key,
        e.event_type,
        e.previous_state,
        e.next_state,
        e.actor_user_id::int AS actor_user_id,
        actor.username AS actor_username,
        e.source,
        e.occurred_at::text AS occurred_at
      FROM public.app_module_access_events e
      LEFT JOIN public.users target ON target.id = e.user_id
      LEFT JOIN public.users actor ON actor.id = e.actor_user_id
      ${whereSql}
      ORDER BY e.occurred_at DESC, e.id DESC
      LIMIT $${values.length + 1}
      OFFSET $${values.length + 2}
    `,
    [...values, filters.limit, filters.offset]
  );

  return { items: dataRes.rows, total: countRes.rows[0]?.total ?? 0 };
}
