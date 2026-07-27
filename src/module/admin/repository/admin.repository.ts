// src/module/admin/repository/admin.repository.ts
import pool from "../../../config/database";
import crypto from "node:crypto";
import type { PoolClient } from "pg";

import { HttpError } from "../../../utils/httpError";
import { normalizeAssignedRoles } from "../../auth/domain/roles";

export type AdminUserListRow = {
  id: number;
  username: string;
  email: string;
  role: string;
  roles: string[];
  status: string | null;
  last_login: string | null;
  profile_incomplete: boolean;
  // Marqueur de compte exposé en LECTURE SEULE : aucune route admin ne l'écrit,
  // il ne s'obtient que par le seed SQL gardé de la tour de contrôle (#326).
  is_superadmin: boolean;
};

export type AdminUserDetailRow = {
  id: number;
  username: string;
  name: string;
  surname: string;
  email: string;
  tel_no: string | null;
  role: string;
  roles: string[];
  gender: string | null;
  address: string | null;
  lane: string | null;
  house_no: string | null;
  postcode: string | null;
  country: string | null;
  salary: number | null;
  date_of_birth: string | null;
  employment_date: string | null;
  employment_end_date: string | null;
  national_id: string | null;
  profile_picture: string | null;
  last_login: string | null;
  status: string | null;
  created_at: string | null;
  social_security_number: string | null;
  profile_incomplete: boolean;
  is_superadmin: boolean;
};

export type AdminRoleRow = {
  role_key: string;
  category: "PRIMARY" | "ORGANIZATION";
  description: string;
};

type PgErrorLike = { code?: unknown; constraint?: unknown };

function isPgUniqueViolation(err: unknown): boolean {
  return (err as PgErrorLike | null)?.code === "23505";
}

function isPgForeignKeyViolation(err: unknown): boolean {
  return (err as PgErrorLike | null)?.code === "23503";
}

function pgConstraint(err: unknown): string | null {
  const v = (err as PgErrorLike | null)?.constraint;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

async function replaceUserRoles(
  client: PoolClient,
  params: {
    userId: number;
    primaryRole: string;
    roles: readonly string[];
    assignedBy: number | null;
  }
): Promise<void> {
  const roles = normalizeAssignedRoles(params.primaryRole, params.roles);
  const existing = await client.query<{ role_key: string }>(
    `SELECT role_key FROM public.user_role_assignments WHERE user_id = $1`,
    [params.userId]
  );
  const previous = new Set(existing.rows.map((row) => row.role_key));
  const next = new Set(roles);
  const assigned = roles.filter((role) => !previous.has(role));
  const revoked = [...previous].filter((role) => !next.has(role));

  await client.query(
    `
      DELETE FROM public.user_role_assignments
      WHERE user_id = $1
        AND NOT (role_key = ANY($2::text[]))
    `,
    [params.userId, roles]
  );
  await client.query(
    `
      INSERT INTO public.user_role_assignments (user_id, role_key, assigned_by)
      SELECT $1, role_key, $3
      FROM unnest($2::text[]) AS assigned(role_key)
      ON CONFLICT (user_id, role_key) DO UPDATE
      SET assigned_by = COALESCE(EXCLUDED.assigned_by, public.user_role_assignments.assigned_by)
    `,
    [params.userId, roles, params.assignedBy]
  );

  if (assigned.length > 0) {
    await client.query(
      `
        INSERT INTO public.user_role_assignment_events (
          user_id, role_key, event_type, actor_user_id, source
        )
        SELECT $1, role_key, 'ASSIGNED', $3, 'admin-api'
        FROM unnest($2::text[]) AS assigned_role(role_key)
      `,
      [params.userId, assigned, params.assignedBy]
    );
  }
  if (revoked.length > 0) {
    await client.query(
      `
        INSERT INTO public.user_role_assignment_events (
          user_id, role_key, event_type, actor_user_id, source
        )
        SELECT $1, role_key, 'REVOKED', $3, 'admin-api'
        FROM unnest($2::text[]) AS revoked_role(role_key)
      `,
      [params.userId, revoked, params.assignedBy]
    );
  }
}

/**
 * `users.is_superadmin` arrive avec le patch #326. Le lire à part garde l'écran des
 * comptes fonctionnel sur une base qui ne l'a pas encore (`42703`), plutôt que de
 * transformer une migration en attente en erreur 500.
 */
async function readSuperadminIds(): Promise<Set<number>> {
  try {
    const { rows } = await pool.query<{ id: number }>(
      `SELECT id::int AS id FROM public.users WHERE is_superadmin`
    );
    return new Set(rows.map((row) => row.id));
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (code === "42703" || code === "42P01") return new Set<number>();
    throw err;
  }
}

export async function repoListUsers(): Promise<AdminUserListRow[]> {
  const superadminIds = await readSuperadminIds();
  const { rows } = await pool.query<AdminUserListRow>(
    `
      SELECT
        u.id::int AS id,
        u.username,
        u.email,
        u.role,
        COALESCE(
          array_agg(ura.role_key ORDER BY (ura.role_key = u.role) DESC, ura.role_key)
            FILTER (WHERE ura.role_key IS NOT NULL),
          ARRAY[u.role]::text[]
        ) AS roles,
        u.status,
        u.last_login::text AS last_login,
        (
          u.tel_no IS NULL
          OR u.address IS NULL
          OR u.date_of_birth IS NULL
          OR u.social_security_number IS NULL
        ) AS profile_incomplete
      FROM public.users u
      LEFT JOIN public.user_role_assignments ura ON ura.user_id = u.id
      GROUP BY u.id
      ORDER BY u.created_at DESC NULLS LAST, u.id DESC
    `
  );
  return rows.map((row) => ({ ...row, is_superadmin: superadminIds.has(row.id) }));
}

export async function repoGetUserById(userId: number): Promise<AdminUserDetailRow | null> {
  const superadminIds = await readSuperadminIds();
  const { rows } = await pool.query<AdminUserDetailRow>(
    `
      SELECT
        u.id::int AS id,
        u.username,
        u.name,
        u.surname,
        u.email,
        u.tel_no,
        u.role,
        COALESCE(
          (
            SELECT array_agg(ura.role_key ORDER BY (ura.role_key = u.role) DESC, ura.role_key)
            FROM public.user_role_assignments ura
            WHERE ura.user_id = u.id
          ),
          ARRAY[u.role]::text[]
        ) AS roles,
        u.gender,
        u.address,
        u.lane,
        u.house_no,
        u.postcode,
        u.country,
        u.salary::float AS salary,
        u.date_of_birth::text AS date_of_birth,
        u.employment_date::text AS employment_date,
        u.employment_end_date::text AS employment_end_date,
        u.national_id,
        u.profile_picture,
        u.last_login::text AS last_login,
        u.status,
        u.created_at::text AS created_at,
        u.social_security_number,
        (
          u.tel_no IS NULL
          OR u.address IS NULL
          OR u.date_of_birth IS NULL
          OR u.social_security_number IS NULL
        ) AS profile_incomplete
      FROM public.users u
      WHERE u.id = $1
      LIMIT 1
    `,
    [userId]
  );
  const row = rows[0];
  return row ? { ...row, is_superadmin: superadminIds.has(row.id) } : null;
}

export async function repoCreateUser(input: {
  username: string;
  passwordHash: string;
  name: string;
  surname: string;
  email: string;
  tel_no: string | null;
  role: string;
  roles: string[];
  assignedBy: number | null;
  gender: string | null;
  address: string | null;
  lane: string | null;
  house_no: string | null;
  postcode: string | null;
  country: string | null;
  salary: number | null;
  date_of_birth: string | null;
  employment_date: string | null;
  employment_end_date: string | null;
  national_id: string | null;
  status: string | null;
  social_security_number: string | null;
}): Promise<AdminUserDetailRow> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: number }>(
      `
        INSERT INTO public.users (
          username,
          password,
          name,
          surname,
          email,
          tel_no,
          role,
          gender,
          address,
          lane,
          house_no,
          postcode,
          country,
          salary,
          date_of_birth,
          employment_date,
          employment_end_date,
          national_id,
          status,
          social_security_number
        ) VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10,
          $11,
          $12,
          COALESCE(NULLIF($13, ''), 'France'),
          $14,
          $15::date,
          COALESCE($16::date, CURRENT_DATE),
          $17::date,
          $18,
          COALESCE(NULLIF($19, ''), 'Active'),
          $20
        )
        RETURNING id::int AS id
      `,
      [
        input.username,
        input.passwordHash,
        input.name,
        input.surname,
        input.email,
        input.tel_no,
        input.role,
        input.gender,
        input.address,
        input.lane,
        input.house_no,
        input.postcode,
        input.country,
        input.salary,
        input.date_of_birth,
        input.employment_date,
        input.employment_end_date,
        input.national_id,
        input.status,
        input.social_security_number,
      ]
    );

    const row = rows[0];
    if (!row) throw new Error("Failed to create user");
    await replaceUserRoles(client, {
      userId: row.id,
      primaryRole: input.role,
      roles: input.roles,
      assignedBy: input.assignedBy,
    });
    await client.query("COMMIT");

    const created = await repoGetUserById(row.id);
    if (!created) throw new Error("Failed to reload created user");
    return created;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
    }
    if (isPgUniqueViolation(err)) {
      const constraint = pgConstraint(err);
      if (constraint === "users_username_key") throw new HttpError(409, "USERNAME_EXISTS", "Username already exists");
      if (constraint === "users_email_key") throw new HttpError(409, "EMAIL_EXISTS", "Email already exists");
      if (constraint === "users_tel_no_key") throw new HttpError(409, "TEL_EXISTS", "Phone number already exists");
      if (constraint === "users_national_id_key") throw new HttpError(409, "NATIONAL_ID_EXISTS", "National ID already exists");
      if (constraint === "users_social_security_number_key")
        throw new HttpError(409, "NIR_EXISTS", "Social security number already exists");
      throw new HttpError(409, "DUPLICATE", "User already exists");
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function repoListRoles(): Promise<AdminRoleRow[]> {
  const { rows } = await pool.query<AdminRoleRow>(
    `
      SELECT role_key, category, description
      FROM public.app_roles
      WHERE is_active = true
      ORDER BY category, role_key
    `
  );
  return rows;
}

export async function repoUpdateUser(
  userId: number,
  patch: Partial<{
    username: string;
    name: string;
    surname: string;
    email: string;
    tel_no: string | null;
    role: string;
    roles: string[];
    assignedBy: number | null;
    gender: string | null;
    address: string | null;
    lane: string | null;
    house_no: string | null;
    postcode: string | null;
    country: string | null;
    salary: number | null;
    date_of_birth: string | null;
    employment_date: string | null;
    employment_end_date: string | null;
    national_id: string | null;
    status: string | null;
    social_security_number: string | null;
  }>
): Promise<AdminUserDetailRow | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  if (patch.username !== undefined) sets.push(`username = ${push(patch.username)}`);
  if (patch.name !== undefined) sets.push(`name = ${push(patch.name)}`);
  if (patch.surname !== undefined) sets.push(`surname = ${push(patch.surname)}`);
  if (patch.email !== undefined) sets.push(`email = ${push(patch.email)}`);
  if (patch.tel_no !== undefined) sets.push(`tel_no = ${push(patch.tel_no)}`);
  if (patch.role !== undefined) sets.push(`role = ${push(patch.role)}`);
  if (patch.gender !== undefined) sets.push(`gender = ${push(patch.gender)}`);
  if (patch.address !== undefined) sets.push(`address = ${push(patch.address)}`);
  if (patch.lane !== undefined) sets.push(`lane = ${push(patch.lane)}`);
  if (patch.house_no !== undefined) sets.push(`house_no = ${push(patch.house_no)}`);
  if (patch.postcode !== undefined) sets.push(`postcode = ${push(patch.postcode)}`);
  if (patch.country !== undefined) sets.push(`country = ${push(patch.country)}`);
  if (patch.salary !== undefined) sets.push(`salary = ${push(patch.salary)}::numeric`);
  if (patch.date_of_birth !== undefined) sets.push(`date_of_birth = ${push(patch.date_of_birth)}::date`);
  if (patch.employment_date !== undefined) sets.push(`employment_date = ${push(patch.employment_date)}::date`);
  if (patch.employment_end_date !== undefined) sets.push(`employment_end_date = ${push(patch.employment_end_date)}::date`);
  if (patch.national_id !== undefined) sets.push(`national_id = ${push(patch.national_id)}`);
  if (patch.status !== undefined) sets.push(`status = ${push(patch.status)}`);
  if (patch.social_security_number !== undefined) sets.push(`social_security_number = ${push(patch.social_security_number)}`);

  if (!sets.length && patch.roles === undefined) return repoGetUserById(userId);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<{ role: string }>(
      `SELECT role FROM public.users WHERE id = $1 FOR UPDATE`,
      [userId]
    );
    const currentRole = current.rows[0]?.role;
    if (!currentRole) {
      await client.query("ROLLBACK");
      return null;
    }

    if (sets.length) {
      values.push(userId);
      await client.query(
        `UPDATE public.users SET ${sets.join(", ")} WHERE id = $${values.length}`,
        values
      );
    }

    if (patch.roles !== undefined || patch.role !== undefined) {
      const existing = await client.query<{ role_key: string }>(
        `SELECT role_key FROM public.user_role_assignments WHERE user_id = $1 ORDER BY role_key`,
        [userId]
      );
      await replaceUserRoles(client, {
        userId,
        primaryRole: patch.role ?? currentRole,
        roles: patch.roles ?? existing.rows.map((row) => row.role_key),
        assignedBy: patch.assignedBy ?? null,
      });
    }

    await client.query("COMMIT");
    return repoGetUserById(userId);
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
    }
    if (isPgUniqueViolation(err)) {
      const constraint = pgConstraint(err);
      if (constraint === "users_username_key") throw new HttpError(409, "USERNAME_EXISTS", "Username already exists");
      if (constraint === "users_email_key") throw new HttpError(409, "EMAIL_EXISTS", "Email already exists");
      if (constraint === "users_tel_no_key") throw new HttpError(409, "TEL_EXISTS", "Phone number already exists");
      if (constraint === "users_national_id_key") throw new HttpError(409, "NATIONAL_ID_EXISTS", "National ID already exists");
      if (constraint === "users_social_security_number_key")
        throw new HttpError(409, "NIR_EXISTS", "Social security number already exists");
      throw new HttpError(409, "DUPLICATE", "User already exists");
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function repoDeleteUser(userId: number): Promise<boolean> {
  try {
    const { rowCount } = await pool.query(`DELETE FROM public.users WHERE id = $1`, [userId]);
    return (rowCount ?? 0) > 0;
  } catch (err) {
    if (isPgForeignKeyViolation(err)) {
      throw new HttpError(409, "USER_IN_USE", "User is referenced and cannot be deleted");
    }
    throw err;
  }
}

export async function repoCreatePasswordResetToken(params: {
  userId: number;
  tokenHash: string;
  expiresAt: Date;
}): Promise<{ token_id: string; user_id: number; username: string; expires_at: string }> {
  const userRes = await pool.query<{ id: number; username: string }>(
    `SELECT id::int AS id, username FROM public.users WHERE id = $1 LIMIT 1`,
    [params.userId]
  );

  const user = userRes.rows[0];
  if (!user) throw new HttpError(404, "USER_NOT_FOUND", "User not found");

  const tokenId = crypto.randomUUID();
  const expiresAtIso = params.expiresAt.toISOString();
  await pool.query(
    `
      INSERT INTO public.password_reset_tokens (id, user_id, token_hash, expires_at)
      VALUES ($1::uuid, $2::int, $3, $4::timestamp)
    `,
    [tokenId, params.userId, params.tokenHash, expiresAtIso]
  );

  return { token_id: tokenId, user_id: user.id, username: user.username, expires_at: expiresAtIso };
}

export async function repoListLoginLogs(filters: {
  from: string;
  to: string;
  success: string;
  username: string;
}) {
  const where: string[] = [];
  const values: any[] = [];

  if (filters.from) {
    values.push(filters.from);
    where.push(`created_at >= $${values.length}::date`);
  }

  if (filters.to) {
    values.push(filters.to);
    where.push(`created_at < ($${values.length}::date + interval '1 day')`);
  }

  if (filters.success === "true" || filters.success === "false") {
    values.push(filters.success === "true");
    where.push(`success = $${values.length}`);
  }

  if (filters.username) {
    values.push(`%${filters.username}%`);
    where.push(`username_attempt ILIKE $${values.length}`);
  }

  const sql = `
    SELECT id, user_id, username_attempt, success, failure_reason, ip,
           device_type, os, browser, created_at
    FROM auth_login_logs
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY created_at DESC
    LIMIT 500
  `;

  const { rows } = await pool.query(sql, values);
  return rows;
}

/**
 * token stored hashed in DB => compare by hashing provided token (sha256)
 */
export async function repoFindResetTokenForUser(userId: string, rawToken: string) {
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");

  const { rows } = await pool.query(
    `SELECT id, user_id, token_hash, expires_at, used_at
     FROM password_reset_tokens
     WHERE user_id = $1::int AND token_hash = $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId, tokenHash]
  );

  return rows[0] ?? null;
}

export async function repoUpdateUserPassword(userId: string, passwordHash: string) {
  await pool.query(`UPDATE public.users SET password = $1 WHERE id = $2::int`, [passwordHash, userId]);
}

export async function repoMarkResetTokenUsed(tokenId: string) {
  await pool.query(`UPDATE public.password_reset_tokens SET used_at = now() WHERE id = $1::uuid`, [tokenId]);
}

export async function repoGetAdminAnalytics(filters: {
  from: string;
  to: string;
  success: string;
  role: string;
  status: string;
}) {
  // Users KPIs
  const { rows: usersRows } = await pool.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE status = 'Active')::int AS active,
       COUNT(*) FILTER (WHERE status = 'Blocked')::int AS blocked
     FROM users`
  );

  // Login logs (30d)
  const { rows: logRows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE created_at >= now() - interval '30 days')::int AS logins30d,
       COUNT(*) FILTER (WHERE created_at >= now() - interval '30 days' AND success = false)::int AS failed30d
     FROM auth_login_logs`
  );

  // Series last 30d
  const { rows: seriesLogins } = await pool.query(
    `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS date,
            COUNT(*)::int AS count
     FROM auth_login_logs
     WHERE created_at >= now() - interval '30 days'
     GROUP BY 1
     ORDER BY 1 ASC`
  );

  const { rows: seriesFailed } = await pool.query(
    `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS date,
            COUNT(*)::int AS count
     FROM auth_login_logs
     WHERE created_at >= now() - interval '30 days' AND success = false
     GROUP BY 1
     ORDER BY 1 ASC`
  );

  return {
    kpis: {
      totalUsers: usersRows[0]?.total ?? 0,
      activeUsers: usersRows[0]?.active ?? 0,
      blockedUsers: usersRows[0]?.blocked ?? 0,
      logins30d: logRows[0]?.logins30d ?? 0,
      failedLogins30d: logRows[0]?.failed30d ?? 0,
    },
    series: {
      loginsByDate: seriesLogins,
      failedLoginsByDate: seriesFailed,
    },
  };
}
