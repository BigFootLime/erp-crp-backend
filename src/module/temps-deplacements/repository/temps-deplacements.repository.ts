import type { PoolClient } from "pg";
import pool from "../../../config/database";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import type { CreateAuditLogBodyDTO } from "../../audit-logs/validators/audit-logs.validators";
import type {
  CreateTimeEventInput,
  HrEmployeeLite,
  HrTimeAnomaly,
  HrTimeEvent,
} from "../types/temps-deplacements.types";

export type DbQueryer = Pick<PoolClient, "query">;

// Contexte d'audit (même forme que le reste de l'ERP). Jamais de secret/PII sensible dedans.
export type AuditContext = {
  user_id: number;
  ip: string | null;
  user_agent: string | null;
  device_type: string | null;
  os: string | null;
  browser: string | null;
  path: string | null;
  page_key: string | null;
  client_session_id: string | null;
};

export function isPgUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "23505";
}

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore
    }
    throw err;
  } finally {
    client.release();
  }
}

const EMP_COLS = `id::text, user_id, matricule, service, manager_user_id, status::text`;

function mapEmployee(r: Record<string, unknown>): HrEmployeeLite {
  return {
    id: String(r.id),
    user_id: Number(r.user_id),
    matricule: String(r.matricule),
    service: (r.service as string | null) ?? null,
    manager_user_id: r.manager_user_id === null || r.manager_user_id === undefined ? null : Number(r.manager_user_id),
    status: r.status as HrEmployeeLite["status"],
  };
}

function mapEvent(r: Record<string, unknown>): HrTimeEvent {
  return {
    id: String(r.id),
    employee_id: String(r.employee_id),
    device_id: (r.device_id as string | null) ?? null,
    event_type: r.event_type as HrTimeEvent["event_type"],
    event_time: String(r.event_time),
    source: r.source as HrTimeEvent["source"],
    created_at: String(r.created_at),
  };
}

function mapAnomaly(r: Record<string, unknown>): HrTimeAnomaly {
  return {
    id: String(r.id),
    employee_id: String(r.employee_id),
    date: String(r.date),
    anomaly_type: r.anomaly_type as HrTimeAnomaly["anomaly_type"],
    severity: r.severity as HrTimeAnomaly["severity"],
    message: (r.message as string | null) ?? null,
    resolved_by: r.resolved_by === null || r.resolved_by === undefined ? null : Number(r.resolved_by),
    resolved_at: (r.resolved_at as string | null) ?? null,
    created_at: String(r.created_at),
  };
}

// -------------------------------------------------------------- Employés
export async function repoGetEmployeeByUserId(userId: number, q: DbQueryer = pool): Promise<HrEmployeeLite | null> {
  const res = await q.query(
    `SELECT ${EMP_COLS} FROM public.hr_employees WHERE user_id = $1 LIMIT 1`,
    [userId]
  );
  return res.rows[0] ? mapEmployee(res.rows[0]) : null;
}

export async function repoGetEmployeeById(id: string, q: DbQueryer = pool): Promise<HrEmployeeLite | null> {
  const res = await q.query(`SELECT ${EMP_COLS} FROM public.hr_employees WHERE id = $1::uuid LIMIT 1`, [id]);
  return res.rows[0] ? mapEmployee(res.rows[0]) : null;
}

// Badge : renvoie l'employé + si le badge est actif (pour distinguer inconnu / révoqué / ok).
export async function repoFindBadge(
  badgeUidHash: string,
  q: DbQueryer = pool
): Promise<{ employee: HrEmployeeLite; active: boolean } | null> {
  const res = await q.query(
    `SELECT b.active, ${EMP_COLS.split(", ").map((c) => "e." + c).join(", ")}
       FROM public.hr_badge_credentials b
       JOIN public.hr_employees e ON e.id = b.employee_id
      WHERE b.badge_uid_hash = $1
      ORDER BY b.active DESC, b.issued_at DESC
      LIMIT 1`,
    [badgeUidHash]
  );
  if (!res.rows[0]) return null;
  return { employee: mapEmployee(res.rows[0]), active: res.rows[0].active === true };
}

// -------------------------------------------------------------- Devices
export async function repoGetActiveDeviceByTokenHash(tokenHash: string, q: DbQueryer = pool): Promise<{ id: string } | null> {
  const res = await q.query(
    `SELECT id::text FROM public.hr_time_clock_devices WHERE device_token_hash = $1 AND status = 'ACTIVE' LIMIT 1`,
    [tokenHash]
  );
  return res.rows[0] ? { id: String(res.rows[0].id) } : null;
}

export async function repoTouchDeviceHeartbeat(deviceId: string, q: DbQueryer = pool): Promise<void> {
  await q.query(`UPDATE public.hr_time_clock_devices SET last_seen_at = now() WHERE id = $1::uuid`, [deviceId]);
}

// -------------------------------------------------------------- Événements (append-only)
export async function repoGetLastEvent(employeeId: string, q: DbQueryer = pool): Promise<HrTimeEvent | null> {
  const res = await q.query(
    `SELECT id::text, employee_id::text, device_id::text, event_type::text, event_time::text, source::text, created_at::text
       FROM public.hr_time_events WHERE employee_id = $1::uuid ORDER BY event_time DESC, created_at DESC LIMIT 1`,
    [employeeId]
  );
  return res.rows[0] ? mapEvent(res.rows[0]) : null;
}

export async function repoFindEventByIdempotencyKey(key: string, q: DbQueryer = pool): Promise<HrTimeEvent | null> {
  const res = await q.query(
    `SELECT id::text, employee_id::text, device_id::text, event_type::text, event_time::text, source::text, created_at::text
       FROM public.hr_time_events WHERE idempotency_key = $1 LIMIT 1`,
    [key]
  );
  return res.rows[0] ? mapEvent(res.rows[0]) : null;
}

// INSERT append-only. Idempotence : si idempotency_key déjà vu → renvoie l'existant (deduplicated).
export async function repoInsertTimeEvent(
  q: DbQueryer,
  input: CreateTimeEventInput
): Promise<{ event: HrTimeEvent; deduplicated: boolean }> {
  if (input.idempotency_key) {
    const existing = await repoFindEventByIdempotencyKey(input.idempotency_key, q);
    if (existing) return { event: existing, deduplicated: true };
  }
  try {
    const res = await q.query(
      `INSERT INTO public.hr_time_events (employee_id, device_id, event_type, event_time, source, idempotency_key, raw_payload_json)
       VALUES ($1::uuid, $2, $3::hr_event_type, COALESCE($4::timestamptz, now()), $5::hr_event_source, $6, $7::jsonb)
       RETURNING id::text, employee_id::text, device_id::text, event_type::text, event_time::text, source::text, created_at::text`,
      [
        input.employee_id,
        input.device_id ?? null,
        input.event_type,
        input.event_time ?? null,
        input.source,
        input.idempotency_key ?? null,
        JSON.stringify(input.raw_payload ?? {}),
      ]
    );
    return { event: mapEvent(res.rows[0]), deduplicated: false };
  } catch (err) {
    // Course sur idempotency_key : la contrainte unique a gagné → renvoyer l'existant.
    if (isPgUniqueViolation(err) && input.idempotency_key) {
      const existing = await repoFindEventByIdempotencyKey(input.idempotency_key, q);
      if (existing) return { event: existing, deduplicated: true };
    }
    throw err;
  }
}

export async function repoListEventsForDay(employeeId: string, date: string, q: DbQueryer = pool): Promise<HrTimeEvent[]> {
  const res = await q.query(
    `SELECT id::text, employee_id::text, device_id::text, event_type::text, event_time::text, source::text, created_at::text
       FROM public.hr_time_events
      WHERE employee_id = $1::uuid AND (event_time AT TIME ZONE 'Europe/Paris')::date = $2::date
      ORDER BY event_time ASC, created_at ASC`,
    [employeeId, date]
  );
  return res.rows.map(mapEvent);
}

// -------------------------------------------------------------- Anomalies
export async function repoInsertAnomaly(
  q: DbQueryer,
  a: { employee_id: string; date: string; anomaly_type: HrTimeAnomaly["anomaly_type"]; severity: HrTimeAnomaly["severity"]; message?: string | null }
): Promise<HrTimeAnomaly> {
  const res = await q.query(
    `INSERT INTO public.hr_time_anomalies (employee_id, date, anomaly_type, severity, message)
     VALUES ($1::uuid, $2::date, $3::hr_anomaly_type, $4::hr_anomaly_severity, $5)
     RETURNING id::text, employee_id::text, date::text, anomaly_type::text, severity::text, message, resolved_by, resolved_at::text, created_at::text`,
    [a.employee_id, a.date, a.anomaly_type, a.severity, a.message ?? null]
  );
  return mapAnomaly(res.rows[0]);
}

export async function repoListAnomalies(
  employeeId: string,
  filters: { date?: string; from?: string; to?: string },
  q: DbQueryer = pool
): Promise<HrTimeAnomaly[]> {
  const where: string[] = ["employee_id = $1::uuid"];
  const vals: unknown[] = [employeeId];
  if (filters.date) {
    vals.push(filters.date);
    where.push(`date = $${vals.length}::date`);
  }
  if (filters.from) {
    vals.push(filters.from);
    where.push(`date >= $${vals.length}::date`);
  }
  if (filters.to) {
    vals.push(filters.to);
    where.push(`date <= $${vals.length}::date`);
  }
  const res = await q.query(
    `SELECT id::text, employee_id::text, date::text, anomaly_type::text, severity::text, message, resolved_by, resolved_at::text, created_at::text
       FROM public.hr_time_anomalies WHERE ${where.join(" AND ")} ORDER BY date DESC, created_at DESC LIMIT 500`,
    vals
  );
  return res.rows.map(mapAnomaly);
}

// Anomalies STRUCTURELLES (dérivées du jour) — DOUBLE_BADGE est event-spécifique et exclu.
const STRUCTURAL_ANOMALY_TYPES = [
  "MISSING_IN", "MISSING_OUT", "MISSING_BREAK_END", "TOO_LONG_DAY", "TOO_SHORT_BREAK", "OUTSIDE_SCHEDULE",
];

// Idempotent : retire les anomalies structurelles non résolues du jour puis réinsère l'ensemble courant.
// Ne touche NI aux DOUBLE_BADGE (event-spécifiques) NI aux anomalies déjà résolues.
export async function repoRefreshDayAnomalies(
  q: DbQueryer,
  employeeId: string,
  date: string,
  anomalies: Array<{ anomaly_type: HrTimeAnomaly["anomaly_type"]; severity: HrTimeAnomaly["severity"]; message?: string | null }>
): Promise<void> {
  await q.query(
    `DELETE FROM public.hr_time_anomalies
      WHERE employee_id = $1::uuid AND date = $2::date AND resolved_at IS NULL
        AND anomaly_type::text = ANY($3::text[])`,
    [employeeId, date, STRUCTURAL_ANOMALY_TYPES]
  );
  for (const a of anomalies) {
    await q.query(
      `INSERT INTO public.hr_time_anomalies (employee_id, date, anomaly_type, severity, message)
       VALUES ($1::uuid, $2::date, $3::hr_anomaly_type, $4::hr_anomaly_severity, $5)`,
      [employeeId, date, a.anomaly_type, a.severity, a.message ?? null]
    );
  }
}

// -------------------------------------------------------------- Contrat (attendu du jour)
export async function repoGetDailyTargetMinutes(employeeId: string, date: string, q: DbQueryer = pool): Promise<number> {
  const res = await q.query(
    `SELECT c.daily_hours_target, rs.daily_target_minutes
       FROM public.hr_employment_contracts c
       LEFT JOIN public.hr_time_rule_sets rs ON rs.id = c.rule_set_id
      WHERE c.employee_id = $1::uuid AND c.active
        AND c.start_date <= $2::date AND (c.end_date IS NULL OR c.end_date >= $2::date)
      ORDER BY c.start_date DESC LIMIT 1`,
    [employeeId, date]
  );
  const row = res.rows[0];
  if (!row) return 0;
  if (row.daily_hours_target != null) return Math.round(Number(row.daily_hours_target) * 60);
  if (row.daily_target_minutes != null) return Number(row.daily_target_minutes);
  return 0;
}

// -------------------------------------------------------------- Timesheet day (persistance de l'agrégat)
export async function repoUpsertTimesheetDay(
  q: DbQueryer,
  d: { employee_id: string; date: string; expected_minutes: number; worked_minutes: number; overtime_minutes: number; missing_minutes: number; anomaly_count: number }
): Promise<void> {
  await q.query(
    `INSERT INTO public.hr_timesheet_days (employee_id, date, expected_minutes, worked_minutes, overtime_minutes, missing_minutes, anomaly_count)
     VALUES ($1::uuid, $2::date, $3, $4, $5, $6, $7)
     ON CONFLICT (employee_id, date) DO UPDATE SET
       expected_minutes = EXCLUDED.expected_minutes,
       worked_minutes = EXCLUDED.worked_minutes,
       overtime_minutes = EXCLUDED.overtime_minutes,
       missing_minutes = EXCLUDED.missing_minutes,
       anomaly_count = EXCLUDED.anomaly_count,
       updated_at = now()
     WHERE public.hr_timesheet_days.validation_status = 'DRAFT'`,
    [d.employee_id, d.date, d.expected_minutes, d.worked_minutes, d.overtime_minutes, d.missing_minutes, d.anomaly_count]
  );
}

// -------------------------------------------------------------- Audit
export async function insertAuditLog(
  tx: DbQueryer,
  audit: AuditContext,
  entry: { action: string; entity_type: string | null; entity_id: string | null; details?: Record<string, unknown> | null }
): Promise<void> {
  const body: CreateAuditLogBodyDTO = {
    event_type: "ACTION",
    action: entry.action,
    page_key: audit.page_key,
    entity_type: entry.entity_type,
    entity_id: entry.entity_id,
    path: audit.path,
    client_session_id: audit.client_session_id,
    details: entry.details ?? null,
  };
  await repoInsertAuditLog({
    user_id: audit.user_id,
    body,
    ip: audit.ip,
    user_agent: audit.user_agent,
    device_type: audit.device_type,
    os: audit.os,
    browser: audit.browser,
    tx,
  });
}
