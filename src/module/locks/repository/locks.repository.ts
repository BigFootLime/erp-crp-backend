import pool from "../../../config/database";
import type { EntityLock } from "../types/locks.types";

const LOCK_TTL_SQL = "10 minutes";

type DbLockRow = {
  id: string;
  entity_type: string;
  entity_id: string;
  locked_at: string;
  expires_at: string;
  locked_by_id: number;
  locked_by_name: string;
};

function toEntityLock(row: DbLockRow): EntityLock {
  return {
    id: row.id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    lockedBy: { id: row.locked_by_id, name: row.locked_by_name },
    lockedAt: row.locked_at,
    expiresAt: row.expires_at,
  };
}

export async function repoGetActiveLock(entity_type: string, entity_id: string): Promise<EntityLock | null> {
  const res = await pool.query<DbLockRow>(
    `
      SELECT
        l.id::text AS id,
        l.entity_type,
        l.entity_id,
        l.locked_at::text AS locked_at,
        l.expires_at::text AS expires_at,
        u.id::int AS locked_by_id,
        u.username AS locked_by_name
      FROM public.entity_locks l
      JOIN public.users u ON u.id = l.locked_by
      WHERE l.entity_type = $1
        AND l.entity_id = $2
        AND l.expires_at > now()
      LIMIT 1
    `,
    [entity_type, entity_id]
  );

  const row = res.rows[0];
  return row ? toEntityLock(row) : null;
}

export async function repoAcquireLock(params: {
  entity_type: string;
  entity_id: string;
  user_id: number;
  reason?: string | null;
}): Promise<{ acquired: boolean; lock: EntityLock | null }> {
  const reason = params.reason ?? null;

  const upsertRes = await pool.query<DbLockRow>(
    `
      WITH upsert AS (
        INSERT INTO public.entity_locks (
          entity_type,
          entity_id,
          locked_by,
          locked_at,
          expires_at,
          reason,
          created_at,
          updated_at
        )
        VALUES (
          $1,
          $2,
          $3,
          now(),
          now() + interval '${LOCK_TTL_SQL}',
          $4,
          now(),
          now()
        )
        ON CONFLICT (entity_type, entity_id) DO UPDATE
          SET
            locked_by = EXCLUDED.locked_by,
            locked_at = now(),
            expires_at = EXCLUDED.expires_at,
            reason = EXCLUDED.reason,
            updated_at = now()
        WHERE public.entity_locks.expires_at <= now()
          OR public.entity_locks.locked_by = EXCLUDED.locked_by
        RETURNING id, entity_type, entity_id, locked_by, locked_at, expires_at
      )
      SELECT
        u.id::text AS id,
        u.entity_type,
        u.entity_id,
        u.locked_at::text AS locked_at,
        u.expires_at::text AS expires_at,
        usr.id::int AS locked_by_id,
        usr.username AS locked_by_name
      FROM upsert u
      JOIN public.users usr ON usr.id = u.locked_by
      LIMIT 1
    `,
    [params.entity_type, params.entity_id, params.user_id, reason]
  );

  const upsertRow = upsertRes.rows[0];
  if (upsertRow) return { acquired: true, lock: toEntityLock(upsertRow) };

  const active = await repoGetActiveLock(params.entity_type, params.entity_id);
  return { acquired: false, lock: active };
}

export async function repoReleaseLock(params: { entity_type: string; entity_id: string; user_id: number }): Promise<boolean> {
  const del = await pool.query<{ id: string }>(
    `
      DELETE FROM public.entity_locks
      WHERE entity_type = $1
        AND entity_id = $2
        AND locked_by = $3
      RETURNING id::text AS id
    `,
    [params.entity_type, params.entity_id, params.user_id]
  );

  // Best-effort cleanup of expired locks.
  await pool.query("DELETE FROM public.entity_locks WHERE expires_at <= now()");

  return (del.rowCount ?? 0) > 0;
}
