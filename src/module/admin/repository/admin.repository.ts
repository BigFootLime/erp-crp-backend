// src/module/admin/repository/admin.repository.ts
import pool from "../../../config/database";
import crypto from "node:crypto";

import { HttpError } from "../../../utils/httpError";

export type AdminUserListRow = {
  id: number;
  username: string;
  email: string;
  role: string;
  status: string | null;
  last_login: string | null;
};

export type AdminUserDetailRow = {
  id: number;
  username: string;
  name: string;
  surname: string;
  email: string;
  tel_no: string;
  role: string;
  gender: string;
  address: string;
  lane: string;
  house_no: string;
  postcode: string;
  country: string | null;
  salary: number | null;
  date_of_birth: string;
  employment_date: string | null;
  employment_end_date: string | null;
  national_id: string | null;
  profile_picture: string | null;
  last_login: string | null;
  status: string | null;
  created_at: string | null;
  social_security_number: string;
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

export async function repoListUsers(): Promise<AdminUserListRow[]> {
  const { rows } = await pool.query<AdminUserListRow>(
    `
      SELECT
        id::int AS id,
        username,
        email,
        role,
        status,
        last_login::text AS last_login
      FROM public.users
      ORDER BY created_at DESC NULLS LAST, id DESC
    `
  );
  return rows;
}

export async function repoGetUserById(userId: number): Promise<AdminUserDetailRow | null> {
  const { rows } = await pool.query<AdminUserDetailRow>(
    `
      SELECT
        id::int AS id,
        username,
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
        salary::float AS salary,
        date_of_birth::text AS date_of_birth,
        employment_date::text AS employment_date,
        employment_end_date::text AS employment_end_date,
        national_id,
        profile_picture,
        last_login::text AS last_login,
        status,
        created_at::text AS created_at,
        social_security_number
      FROM public.users
      WHERE id = $1
      LIMIT 1
    `,
    [userId]
  );
  return rows[0] ?? null;
}

export async function repoCreateUser(input: {
  username: string;
  passwordHash: string;
  name: string;
  surname: string;
  email: string;
  tel_no: string;
  role: string;
  gender: string;
  address: string;
  lane: string;
  house_no: string;
  postcode: string;
  country: string | null;
  salary: number | null;
  date_of_birth: string;
  employment_date: string | null;
  employment_end_date: string | null;
  national_id: string | null;
  status: string | null;
  social_security_number: string;
}): Promise<AdminUserDetailRow> {
  try {
    const { rows } = await pool.query<AdminUserDetailRow>(
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
        RETURNING
          id::int AS id,
          username,
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
          salary::float AS salary,
          date_of_birth::text AS date_of_birth,
          employment_date::text AS employment_date,
          employment_end_date::text AS employment_end_date,
          national_id,
          profile_picture,
          last_login::text AS last_login,
          status,
          created_at::text AS created_at,
          social_security_number
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
    return row;
  } catch (err) {
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
  }
}

export async function repoUpdateUser(
  userId: number,
  patch: Partial<{
    username: string;
    name: string;
    surname: string;
    email: string;
    tel_no: string;
    role: string;
    gender: string;
    address: string;
    lane: string;
    house_no: string;
    postcode: string;
    country: string | null;
    salary: number | null;
    date_of_birth: string;
    employment_date: string | null;
    employment_end_date: string | null;
    national_id: string | null;
    status: string | null;
    social_security_number: string;
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

  if (!sets.length) return repoGetUserById(userId);

  const sql = `UPDATE public.users SET ${sets.join(", ")} WHERE id = ${push(userId)} RETURNING id::int AS id`;

  try {
    const res = await pool.query<{ id: number }>(sql, values);
    const rowId = res.rows[0]?.id;
    if (!rowId) return null;
    return repoGetUserById(rowId);
  } catch (err) {
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
