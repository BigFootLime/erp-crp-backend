// src/module/admin/repository/admin.repository.ts
import pool from "../../../config/database";
import crypto from "node:crypto";

export async function repoListUsers() {
  const { rows } = await pool.query(
    `SELECT id, username, email, role, status
     FROM users
     ORDER BY created_at DESC NULLS LAST, id DESC`
  );
  return rows;
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
     WHERE user_id = $1 AND token_hash = $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId, tokenHash]
  );

  return rows[0] ?? null;
}

export async function repoUpdateUserPassword(userId: string, passwordHash: string) {
  await pool.query(`UPDATE users SET password = $1 WHERE id = $2`, [passwordHash, userId]);
}

export async function repoMarkResetTokenUsed(tokenId: string) {
  await pool.query(`UPDATE password_reset_tokens SET used_at = now() WHERE id = $1`, [tokenId]);
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
