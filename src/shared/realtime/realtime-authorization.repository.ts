import pool from "../../config/database";
import { authorizationRole, normalizeAssignedRoles } from "../../module/auth/domain/roles";

export type RealtimeAccountAuthorization = {
  active: boolean;
  role: string;
  primaryRole: string;
  roles: string[];
};

type RealtimeAccountRow = {
  role: string;
  status: string | null;
  roles: string[] | null;
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
        COALESCE(
          array_agg(ura.role_key ORDER BY (ura.role_key = u.role) DESC, ura.role_key)
            FILTER (WHERE ura.role_key IS NOT NULL),
          ARRAY[u.role]::text[]
        ) AS roles
      FROM public.users u
      LEFT JOIN public.user_role_assignments ura ON ura.user_id = u.id
      WHERE u.id = $1
      GROUP BY u.id
      LIMIT 1
    `,
    [userId]
  );

  const row = rows[0];
  if (!row) return null;
  const roles = normalizeAssignedRoles(row.role, row.roles);
  return {
    active: String(row.status ?? "").trim().toLowerCase() === "active",
    role: authorizationRole(row.role, roles),
    primaryRole: row.role,
    roles,
  };
}
