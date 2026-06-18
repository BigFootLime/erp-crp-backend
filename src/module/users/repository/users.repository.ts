import pool from "../../../config/database";
import type { AssignableUser } from "../types/users.types";

type AssignableUserRow = AssignableUser;

export async function repoListAssignableUsers(params: {
  q?: string;
  role?: string;
  limit?: number;
}): Promise<AssignableUser[]> {
  const q = typeof params.q === "string" ? params.q.trim() : "";
  const role = typeof params.role === "string" ? params.role.trim() : "";
  const limit = Math.max(1, Math.min(500, Math.trunc(params.limit ?? 200)));

  const res = await pool.query<AssignableUserRow>(
    `
      SELECT
        u.id::int AS id,
        u.username,
        u.name,
        u.surname,
        u.role,
        u.status
      FROM public.users u
      WHERE COALESCE(NULLIF(lower(trim(u.status)), ''), 'active') NOT IN ('inactive', 'blocked', 'suspended')
        AND (
          $1::text = ''
          OR lower(u.username) LIKE ('%' || lower($1::text) || '%')
          OR lower(COALESCE(u.name, '')) LIKE ('%' || lower($1::text) || '%')
          OR lower(COALESCE(u.surname, '')) LIKE ('%' || lower($1::text) || '%')
          OR lower(COALESCE(u.role, '')) LIKE ('%' || lower($1::text) || '%')
        )
        AND (
          $2::text = ''
          OR lower(COALESCE(u.role, '')) LIKE ('%' || lower($2::text) || '%')
        )
      ORDER BY u.username ASC, u.id ASC
      LIMIT $3::int
    `,
    [q, role, limit]
  );

  return res.rows;
}
