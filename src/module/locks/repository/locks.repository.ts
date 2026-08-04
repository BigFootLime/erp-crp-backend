import pool from "../../../config/database";
import { withRealtimeOutboxTransaction } from "../../../shared/realtime/realtime-outbox-transaction";
import { enqueueLockUpdated } from "../../../shared/realtime/realtime-outbox.service";
import type { EntityLock } from "../types/locks.types";
import type { PoolClient } from "pg";

const LOCK_TTL_SQL = "10 minutes";

export type LockableEntityType = "COMMANDE_CLIENT" | "OF" | "PIECE_TECHNIQUE";

type DbLockRow = {
  id: string;
  entity_type: string;
  entity_id: string;
  locked_at: string;
  expires_at: string;
  locked_by_id: number;
  locked_by_name: string;
};

type ExpiredLockRow = Pick<DbLockRow, "id" | "entity_type" | "entity_id" | "expires_at">;

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

export async function repoGetActiveLock(
  entity_type: string,
  entity_id: string,
  tx?: Pick<PoolClient, "query">
): Promise<EntityLock | null> {
  const res = await (tx ?? pool).query<DbLockRow>(
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
  entity_type: LockableEntityType;
  entity_id: string;
  user_id: number;
  reason?: string | null;
}): Promise<{ entityExists: boolean; acquired: boolean; lock: EntityLock | null }> {
  const reason = params.reason ?? null;

  const client = await pool.connect();
  return withRealtimeOutboxTransaction(client, async (tx) => {
    if (!(await lockableEntityExists(tx, params.entity_type, params.entity_id))) {
      return { entityExists: false, acquired: false, lock: null };
    }
    const upsertRes = await tx.query<DbLockRow>(
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
    if (upsertRow) {
      const lock = toEntityLock(upsertRow);
      await enqueueLockUpdated(tx, {
        entityType: lock.entityType,
        entityId: lock.entityId,
        locked: true,
        lock,
      }, { deduplicationKey: `lock:${lock.id}:held:${lock.expiresAt}` });
      return { entityExists: true, acquired: true, lock };
    }

    const active = await repoGetActiveLock(params.entity_type, params.entity_id, tx);
    return { entityExists: true, acquired: false, lock: active };
  });
}

async function lockableEntityExists(
  tx: Pick<PoolClient, "query">,
  entityType: LockableEntityType,
  entityId: string
): Promise<boolean> {
  const statement = entityType === "PIECE_TECHNIQUE"
    ? `SELECT EXISTS (
         SELECT 1 FROM public.pieces_techniques
         WHERE id = $1::uuid AND deleted_at IS NULL
       ) AS entity_exists`
    : entityType === "COMMANDE_CLIENT"
      ? `SELECT EXISTS (
           SELECT 1 FROM public.commande_client WHERE id = $1::bigint
         ) AS entity_exists`
      : `SELECT EXISTS (
           SELECT 1 FROM public.ordres_fabrication WHERE id = $1::bigint
         ) AS entity_exists`;
  const { rows } = await tx.query<{ entity_exists: boolean }>(statement, [entityId]);
  return rows[0]?.entity_exists === true;
}

export async function repoReleaseLock(params: {
  entity_type: LockableEntityType;
  entity_id: string;
  user_id: number;
}): Promise<{ entityExists: boolean; released: boolean }> {
  const client = await pool.connect();
  return withRealtimeOutboxTransaction(client, async (tx) => {
    if (!(await lockableEntityExists(tx, params.entity_type, params.entity_id))) {
      return { entityExists: false, released: false };
    }
    const del = await tx.query<{ id: string }>(
    `
      DELETE FROM public.entity_locks
      WHERE entity_type = $1
        AND entity_id = $2
        AND locked_by = $3
      RETURNING id::text AS id
    `,
    [params.entity_type, params.entity_id, params.user_id]
  );

    if ((del.rowCount ?? 0) > 0) {
      await enqueueLockUpdated(tx, {
        entityType: params.entity_type,
        entityId: params.entity_id,
        locked: false,
        lock: null,
      }, { deduplicationKey: `lock:${del.rows[0]!.id}:released` });
    }

    return { entityExists: true, released: (del.rowCount ?? 0) > 0 };
  });
}

/**
 * Claims and expires a bounded batch across all server instances. The DELETE
 * and every durable unlock event share one transaction, so a client can never
 * retain an expired lock merely because no user happened to retry/release it.
 */
export async function repoExpireLocks(limit = 500): Promise<number> {
  const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 1_000));
  const client = await pool.connect();
  return withRealtimeOutboxTransaction(client, async (tx) => {
    const { rows } = await tx.query<ExpiredLockRow>(
      `
        WITH expired AS (
          SELECT id
          FROM public.entity_locks
          WHERE expires_at <= now()
            AND entity_type IN ('COMMANDE_CLIENT', 'OF', 'PIECE_TECHNIQUE')
          ORDER BY expires_at ASC, id ASC
          FOR UPDATE SKIP LOCKED
          LIMIT $1
        )
        DELETE FROM public.entity_locks lock
        USING expired
        WHERE lock.id = expired.id
          AND lock.expires_at <= now()
        RETURNING
          lock.id::text AS id,
          lock.entity_type,
          lock.entity_id,
          lock.expires_at::text AS expires_at
      `,
      [boundedLimit]
    );

    for (const row of rows) {
      await enqueueLockUpdated(tx, {
        entityType: row.entity_type,
        entityId: row.entity_id,
        locked: false,
        lock: null,
      }, { deduplicationKey: `lock:${row.id}:expired:${row.expires_at}` });
    }
    return rows.length;
  });
}
