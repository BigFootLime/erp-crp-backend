import type { PoolClient } from "pg";

import pool from "../../../config/database";

type DbQueryer = Pick<PoolClient, "query">;

export type PasswordResetRow = {
  id: string;
  user_id: number;
  token_hash: string;
  expires_at: string;
  used: boolean;
  created_at: string;
};

export async function repoDeleteActivePasswordResetsForUser(params: {
  user_id: number;
  tx?: DbQueryer;
}) {
  const q = params.tx ?? pool;
  await q.query(
    `
      DELETE FROM public.password_resets
      WHERE user_id = $1
        AND used = FALSE
    `,
    [params.user_id]
  );
}

export async function repoInsertPasswordReset(params: {
  id: string;
  user_id: number;
  token_hash: string;
  expires_at: Date;
  tx?: DbQueryer;
}): Promise<{ id: string } | null> {
  const q = params.tx ?? pool;
  const ins = await q.query<{ id: string }>(
    `
      INSERT INTO public.password_resets (
        id,
        user_id,
        token_hash,
        expires_at
      ) VALUES ($1::uuid, $2::int, $3::text, $4::timestamp)
      RETURNING id::text AS id
    `,
    [params.id, params.user_id, params.token_hash, params.expires_at]
  );
  return ins.rows[0] ?? null;
}

export async function repoGetPasswordResetForUpdate(params: {
  token_hash: string;
  tx: DbQueryer;
}): Promise<Pick<PasswordResetRow, "id" | "user_id"> | null> {
  const res = await params.tx.query<Pick<PasswordResetRow, "id" | "user_id">>(
    `
      SELECT
        id::text AS id,
        user_id
      FROM public.password_resets
      WHERE token_hash = $1::text
        AND used = FALSE
        AND expires_at > now()
      LIMIT 1
      FOR UPDATE
    `,
    [params.token_hash]
  );
  return res.rows[0] ?? null;
}

export async function repoMarkPasswordResetUsed(params: { id: string; tx: DbQueryer }) {
  await params.tx.query(
    `
      UPDATE public.password_resets
      SET used = TRUE
      WHERE id = $1::uuid
    `,
    [params.id]
  );
}

export async function repoDeleteOtherActivePasswordResetsForUser(params: {
  user_id: number;
  keep_id: string;
  tx: DbQueryer;
}) {
  await params.tx.query(
    `
      DELETE FROM public.password_resets
      WHERE user_id = $1::int
        AND used = FALSE
        AND id <> $2::uuid
    `,
    [params.user_id, params.keep_id]
  );
}

export async function repoCleanupExpiredPasswordResets(params: { tx?: DbQueryer }) {
  const q = params.tx ?? pool;
  await q.query(
    `
      DELETE FROM public.password_resets
      WHERE expires_at <= now()
    `
  );
}
