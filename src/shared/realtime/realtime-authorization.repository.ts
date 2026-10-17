import pool from "../../config/database";
import { authorizationRole, normalizeAssignedRoles } from "../../module/auth/domain/roles";
import { accountRequiresMfa, normalizeMfaPolicy } from "../../module/auth/domain/mfa-policy";

export type RealtimeAccountAuthorization = {
  active: boolean;
  role: string;
  primaryRole: string;
  roles: string[];
  sessionEpoch: number;
  mfaRequired: boolean;
  mfaFactorId: string | null;
  mfaFactorVersion: number | null;
};

type RealtimeAccountRow = {
  role: string;
  status: string | null;
  roles: string[] | null;
  session_epoch: string;
  is_superadmin: boolean;
  mfa_reenrollment_required: boolean;
  mfa_policy: string | null;
  mfa_factor_id: string | null;
  mfa_factor_version: number | null;
};

/**
 * Reloads mutable authorization data instead of trusting the role snapshot in
 * a long-lived JWT. No identity or contact data leaves this repository.
 */
export async function repoRealtimeAccountAuthorization(
  userId: number
): Promise<RealtimeAccountAuthorization | null> {
  const { rows } = await pool.query<RealtimeAccountRow>(
    `
      SELECT
        u.role,
        u.status,
        u.is_superadmin,
        u.mfa_reenrollment_required,
        (SELECT value_text FROM public.erp_settings WHERE key='security.mfa_policy' LIMIT 1) AS mfa_policy,
        factor.id::text AS mfa_factor_id,
        factor.version AS mfa_factor_version,
        COALESCE(rse.session_epoch, 0)::text AS session_epoch,
        COALESCE(
          array_agg(ura.role_key ORDER BY (ura.role_key = u.role) DESC, ura.role_key)
            FILTER (WHERE ura.role_key IS NOT NULL),
          ARRAY[u.role]::text[]
        ) AS roles
      FROM public.users u
      LEFT JOIN public.realtime_session_epochs rse ON rse.user_id = u.id
      LEFT JOIN public.user_role_assignments ura ON ura.user_id = u.id
      LEFT JOIN public.user_mfa_factors factor ON factor.user_id = u.id AND factor.state = 'ACTIVE'
      WHERE u.id = $1
      GROUP BY u.id, rse.session_epoch, factor.id, factor.version
      LIMIT 1
    `,
    [userId]
  );

  const row = rows[0];
  if (!row) return null;
  const roles = normalizeAssignedRoles(row.role, row.roles);
  const sessionEpoch = Number.parseInt(row.session_epoch, 10);
  return {
    active: String(row.status ?? "").trim().toLowerCase() === "active",
    role: authorizationRole(row.role, roles),
    primaryRole: row.role,
    roles,
    sessionEpoch: Number.isSafeInteger(sessionEpoch) && sessionEpoch >= 0 ? sessionEpoch : 0,
    mfaRequired: row.mfa_reenrollment_required || accountRequiresMfa({ policy: normalizeMfaPolicy(row.mfa_policy), isSuperadmin: row.is_superadmin, role: row.role, roles, hasActiveFactor: Boolean(row.mfa_factor_id) }),
    mfaFactorId: row.mfa_factor_id,
    mfaFactorVersion: row.mfa_factor_version,
  };
}
