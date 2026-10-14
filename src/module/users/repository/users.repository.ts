import pool from "../../../config/database";
import type { AssignableUser } from "../types/users.types";
import {directoryUsernameSql,directoryRosterFilter} from '../../../shared-directory/display';
import {synchronizeDirectoryRoster} from '../../../shared-directory/roster.runtime';

type AssignableUserRow = AssignableUser;

export async function repoListAssignableUsers(params: {
  q?: string;
  role?: string;
  limit?: number;
  directorySession?:string;
}): Promise<AssignableUser[]> {
  const q = typeof params.q === "string" ? params.q.trim() : "";
  const role = typeof params.role === "string" ? params.role.trim() : "";
  const limit = Math.max(1, Math.min(500, Math.trunc(params.limit ?? 200)));
  if(params.directorySession)await synchronizeDirectoryRoster(pool,params.directorySession);

  const res = await pool.query<AssignableUserRow>(
    `
      SELECT
        u.id::int AS id,
        ${directoryUsernameSql('u')} AS username,
        u.name,
        u.surname,
        u.role,
        u.status
      FROM public.users u
      WHERE COALESCE(NULLIF(lower(trim(u.status)), ''), 'active') NOT IN ('inactive', 'blocked', 'suspended')
        ${directoryRosterFilter('u')}
        AND (
          $1::text = ''
          OR lower(${directoryUsernameSql('u')}) LIKE ('%' || lower($1::text) || '%')
          OR lower(COALESCE(u.name, '')) LIKE ('%' || lower($1::text) || '%')
          OR lower(COALESCE(u.surname, '')) LIKE ('%' || lower($1::text) || '%')
          OR lower(COALESCE(u.role, '')) LIKE ('%' || lower($1::text) || '%')
        )
        AND (
          $2::text = ''
          OR lower(COALESCE(u.role, '')) LIKE ('%' || lower($2::text) || '%')
        )
      ORDER BY ${directoryUsernameSql('u')} ASC, u.id ASC
      LIMIT $3::int
    `,
    [q, role, limit]
  );

  return res.rows;
}
