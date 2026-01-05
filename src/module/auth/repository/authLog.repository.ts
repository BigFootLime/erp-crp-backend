import pool from "../../../config/database";

export async function insertLoginLog(params: {
  user_id: number | null;
  username_attempt: string;
  success: boolean;
  failure_reason?: string | null;
  ip?: string | null;
  user_agent?: string | null;
  device_type?: string | null;
  os?: string | null;
  browser?: string | null;
}) {
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO auth_login_logs (
        user_id, username_attempt, success, failure_reason,
        ip, user_agent, device_type, os, browser
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        params.user_id,
        params.username_attempt,
        params.success,
        params.failure_reason ?? null,
        params.ip ?? null,
        params.user_agent ?? null,
        params.device_type ?? null,
        params.os ?? null,
        params.browser ?? null,
      ]
    );
  } finally {
    client.release();
  }
}
