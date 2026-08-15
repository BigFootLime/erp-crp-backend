import pool from '../../../config/database';
import type { PoolClient } from 'pg';
import {
  bumpRealtimeAuthorizationEpoch,
  bumpRealtimeSessionEpoch,
  type RealtimeDbQueryer,
} from '../../../shared/realtime/realtime-control-plane';
import { withRealtimeOutboxTransaction } from '../../../shared/realtime/realtime-outbox-transaction';
import {
  canonicalizeAuthEmail,
  canonicalizeAuthUsername,
} from '../domain/auth-identity';

type AuthEpochMutation<T> = {
  value: T;
  userId: number;
  kind?: 'create' | 'password';
  expectedSessionEpoch?: number;
  previousSessionEpoch?: number;
  expectedPasswordHash?: string;
  previousPasswordHash?: string;
  noOp?: boolean;
};

async function reconcileAuthEpochMutation(verifier: PoolClient, mutation: AuthEpochMutation<unknown>) {
  if (mutation.noOp) return 'committed' as const;
  const { rows } = await verifier.query<{
    user_exists: boolean;
    password_hash: string | null;
    session_epoch: string;
  }>(
    `
      SELECT
        EXISTS(SELECT 1 FROM public.users WHERE id = $1)::boolean AS user_exists,
        (SELECT password FROM public.users WHERE id = $1) AS password_hash,
        COALESCE((SELECT session_epoch FROM public.realtime_session_epochs WHERE user_id = $1), 0)::text AS session_epoch
    `,
    [mutation.userId]
  );
  const row = rows[0];
  if (!row) return 'unknown' as const;
  if (mutation.kind === 'create') return row.user_exists ? 'committed' as const : 'not_committed' as const;

  const session = Number.parseInt(row.session_epoch, 10);
  if (
    mutation.kind === 'password'
    && row.user_exists
    && row.password_hash === mutation.expectedPasswordHash
    && mutation.expectedSessionEpoch !== undefined
    && session >= mutation.expectedSessionEpoch
  ) return 'committed' as const;
  if (
    mutation.kind === 'password'
    && row.user_exists
    && row.password_hash === mutation.previousPasswordHash
    && mutation.previousSessionEpoch !== undefined
    && session <= mutation.previousSessionEpoch
  ) return 'not_committed' as const;
  return 'unknown' as const;
}

// 🔍 Cherche un utilisateur par email
export const findUserByUsername = async (username: string) => {
  const canonicalUsername = canonicalizeAuthUsername(username);
  const client = await pool.connect();
  try {
    const result = await client.query(
      `
        SELECT
          u.*,
          COALESCE(rse.session_epoch, 0)::text AS realtime_session_epoch,
          COALESCE(
            array_agg(ura.role_key ORDER BY (ura.role_key = u.role) DESC, ura.role_key)
              FILTER (WHERE ura.role_key IS NOT NULL),
            ARRAY[u.role]::text[]
          ) AS roles
        FROM public.users u
        LEFT JOIN public.realtime_session_epochs rse ON rse.user_id = u.id
        LEFT JOIN public.user_role_assignments ura ON ura.user_id = u.id
        WHERE u.username = $1
        GROUP BY u.id, rse.session_epoch
        LIMIT 1
      `,
      [canonicalUsername]
    );
    return result.rows[0]; // undefined si pas trouvé
  } finally {
    client.release();
  }
};

export type AuthUserLookupRow = {
  id: number;
  username: string;
  email: string | null;
  password?: string;
};

export type AuthenticatedAccountState = {
  status: string | null;
  session_epoch: number;
  is_superadmin: boolean;
  mfa_required: boolean;
  mfa_factor_id: string | null;
  mfa_factor_version: number | null;
};

/**
 * Resolve the live account state for an already verified JWT. This check stays
 * database-backed so disabling an account takes effect immediately for HTTP
 * requests instead of waiting for the access token to expire.
 */
export const findAuthenticatedAccountState = async (
  userId: number,
): Promise<AuthenticatedAccountState | null> => {
  const { rows } = await pool.query<{
    status: string | null;
    session_epoch: string;
    is_superadmin: boolean;
    mfa_factor_id: string | null;
    mfa_factor_version: number | null;
  }>(
    `
      SELECT
        users.status,
        users.is_superadmin,
        factor.id::text AS mfa_factor_id,
        factor.version AS mfa_factor_version,
        COALESCE(epochs.session_epoch, 0)::text AS session_epoch
      FROM public.users
      LEFT JOIN public.realtime_session_epochs epochs ON epochs.user_id = users.id
      LEFT JOIN public.user_mfa_factors factor ON factor.user_id = users.id AND factor.state = 'ACTIVE'
      WHERE users.id = $1
      LIMIT 1
    `,
    [userId],
  );
  const row = rows[0];
  if (!row) return null;
  const sessionEpoch = Number.parseInt(row.session_epoch, 10);
  return {
    status: row.status,
    session_epoch: Number.isSafeInteger(sessionEpoch) && sessionEpoch >= 0 ? sessionEpoch : 0,
    is_superadmin: row.is_superadmin === true,
    mfa_required: row.is_superadmin === true || Boolean(row.mfa_factor_id),
    mfa_factor_id: row.mfa_factor_id ?? null,
    mfa_factor_version: row.mfa_factor_version ?? null,
  };
};

export const findUserByUsernameOrEmail = async (usernameOrEmail: string): Promise<AuthUserLookupRow | null> => {
  const raw = typeof usernameOrEmail === "string" ? usernameOrEmail : "";
  if (!raw) return null;

  const normalizedUsername = canonicalizeAuthUsername(raw);
  const normalizedEmail = canonicalizeAuthEmail(raw);
  if (!normalizedUsername && !normalizedEmail) return null;

  const client = await pool.connect();
  try {
    const result = await client.query<AuthUserLookupRow>(
      `
        SELECT id, username, email, password
        FROM users
        WHERE username = $1
           OR LOWER(email) = $2
        LIMIT 1
      `,
      [normalizedUsername, normalizedEmail]
    );
    return result.rows[0] ?? null;
  } finally {
    client.release();
  }
};

export const updateUserPassword = async (params: { userId: number; passwordHash: string; tx?: RealtimeDbQueryer }) => {
  const work = async (q: RealtimeDbQueryer): Promise<AuthEpochMutation<void>> => {
    const previous = await q.query<{ password_hash: string; session_epoch: string }>(
      `
        SELECT
          users.password AS password_hash,
          COALESCE(epochs.session_epoch, 0)::text AS session_epoch
        FROM public.users
        LEFT JOIN public.realtime_session_epochs epochs ON epochs.user_id = users.id
        WHERE users.id = $1
        FOR UPDATE OF users
      `,
      [params.userId]
    );
    const previousRow = previous.rows[0];
    if (!previousRow) return { value: undefined, userId: params.userId, noOp: true };
    const result = await q.query(
      `
        UPDATE users
        SET password = $1
        WHERE id = $2
      `,
      [params.passwordHash, params.userId]
    );
    if ((result.rowCount ?? 0) === 0) return { value: undefined, userId: params.userId, noOp: true };
    const expectedSessionEpoch = await bumpRealtimeSessionEpoch(q, params.userId);
    return {
      value: undefined,
      userId: params.userId,
      kind: 'password',
      expectedSessionEpoch,
      previousSessionEpoch: Number.parseInt(previousRow.session_epoch, 10),
      expectedPasswordHash: params.passwordHash,
      previousPasswordHash: previousRow.password_hash,
    };
  };
  if (params.tx) {
    return work(params.tx);
  }
  const client = await pool.connect();
  return withRealtimeOutboxTransaction(client, work, { reconcileCommit: reconcileAuthEpochMutation });
};

