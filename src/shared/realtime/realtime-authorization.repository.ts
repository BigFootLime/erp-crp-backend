import pool from "../../config/database";
import { authorizationRole, normalizeAssignedRoles } from "../../module/auth/domain/roles";

export type RealtimeAccountAuthorization = {
  active: boolean;
  role: string;
  primaryRole: string;
  roles: string[];
  sessionEpoch: number;
};

type RealtimeAccountRow = {
  role: string;
  status: string | null;
  roles: string[] | null;
  session_epoch: string;
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
        COALESCE(rse.session_epoch, 0)::text AS session_epoch,
        COALESCE(
          array_agg(ura.role_key ORDER BY (ura.role_key = u.role) DESC, ura.role_key)
            FILTER (WHERE ura.role_key IS NOT NULL),
          ARRAY[u.role]::text[]
        ) AS roles
      FROM public.users u
      LEFT JOIN public.realtime_session_epochs rse ON rse.user_id = u.id
      LEFT JOIN public.user_role_assignments ura ON ura.user_id = u.id
      WHERE u.id = $1
      GROUP BY u.id, rse.session_epoch
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
  };
}
