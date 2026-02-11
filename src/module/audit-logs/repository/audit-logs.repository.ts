import pool from "../../../config/database";
import type { AuditLogRow, Paginated } from "../types/audit-logs.types";
import type { CreateAuditLogBodyDTO, ListAuditLogsQueryDTO } from "../validators/audit-logs.validators";

export async function repoInsertAuditLog(params: {
  user_id: number;
  body: CreateAuditLogBodyDTO;
  ip: string | null;
  user_agent: string | null;
  device_type: string | null;
  os: string | null;
  browser: string | null;
}) {
  const { body } = params;

  const ins = await pool.query<{ id: string; created_at: string }>(
    `
      INSERT INTO erp_audit_logs (
        user_id,
        event_type,
        action,
        page_key,
        entity_type,
        entity_id,
        path,
        client_session_id,
        ip,
        user_agent,
        device_type,
        os,
        browser,
        details
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      RETURNING id::text AS id, created_at::text AS created_at
    `,
    [
      params.user_id,
      body.event_type,
      body.action,
      body.page_key ?? null,
      body.entity_type ?? null,
      body.entity_id ?? null,
      body.path ?? null,
      body.client_session_id ?? null,
      params.ip,
      params.user_agent,
      params.device_type,
      params.os,
      params.browser,
      body.details ? JSON.stringify(body.details) : null,
    ]
  );

  return ins.rows[0] ?? null;
}

export async function repoListAuditLogs(filters: ListAuditLogsQueryDTO): Promise<Paginated<AuditLogRow>> {
  const where: string[] = [];
  const values: unknown[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  if (filters.from) {
    where.push(`a.created_at >= ${push(filters.from)}::date`);
  }
  if (filters.to) {
    where.push(`a.created_at < (${push(filters.to)}::date + interval '1 day')`);
  }
  if (typeof filters.user_id === "number") {
    where.push(`a.user_id = ${push(filters.user_id)}`);
  }
  if (filters.event_type) {
    where.push(`a.event_type = ${push(filters.event_type)}`);
  }
  if (filters.action) {
    where.push(`a.action ILIKE ${push(`%${filters.action}%`)}`);
  }
  if (filters.page_key) {
    where.push(`a.page_key ILIKE ${push(`%${filters.page_key}%`)}`);
  }
  if (filters.q) {
    const q = `%${filters.q}%`;
    const p = push(q);
    where.push(`(
      a.action ILIKE ${p}
      OR COALESCE(a.page_key,'') ILIKE ${p}
      OR COALESCE(a.path,'') ILIKE ${p}
      OR COALESCE(a.entity_type,'') ILIKE ${p}
      OR COALESCE(a.entity_id,'') ILIKE ${p}
      OR COALESCE(u.username,'') ILIKE ${p}
    )`);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 50;
  const offset = (page - 1) * pageSize;

  const countSql = `
    SELECT COUNT(*)::int AS total
    FROM erp_audit_logs a
    LEFT JOIN users u ON u.id = a.user_id
    ${whereSql}
  `;
  const countRes = await pool.query<{ total: number }>(countSql, values);
  const total = countRes.rows[0]?.total ?? 0;

  const orderDir = filters.sortDir === "asc" ? "ASC" : "DESC";
  const dataSql = `
    SELECT
      a.id::text AS id,
      a.created_at::text AS created_at,
      a.user_id,
      u.username,
      u.role,
      a.event_type,
      a.action,
      a.page_key,
      a.entity_type,
      a.entity_id,
      a.path,
      a.client_session_id::text AS client_session_id,
      a.ip,
      a.user_agent,
      a.device_type,
      a.os,
      a.browser,
      a.details
    FROM erp_audit_logs a
    LEFT JOIN users u ON u.id = a.user_id
    ${whereSql}
    ORDER BY a.created_at ${orderDir}, a.id ${orderDir}
    LIMIT $${values.length + 1}
    OFFSET $${values.length + 2}
  `;

  const dataRes = await pool.query<AuditLogRow>(dataSql, [...values, pageSize, offset]);
  return { items: dataRes.rows, total };
}
