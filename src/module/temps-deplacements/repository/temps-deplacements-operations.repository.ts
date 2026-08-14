import pool from "../../../config/database";
import type { DbQueryer } from "./temps-deplacements.repository";

export type HrAbsenceStatus = "REQUESTED" | "APPROVED" | "REJECTED" | "CANCELLED";
export type HrAbsenceRecord = {
  id: string;
  employee_id: string;
  absence_date: string;
  minutes: number;
  absence_type: "PAID_LEAVE" | "SICK_LEAVE" | "RTT" | "TRAINING" | "OTHER";
  timezone: string;
  status: HrAbsenceStatus;
  reason: string;
  source_ref: string | null;
  requested_by: number;
  decided_by: number | null;
  decided_at: string | null;
  created_at: string;
  updated_at: string;
};

export type HrPeriodClosure = {
  id: string;
  period_start: string;
  period_end: string;
  employee_id: string | null;
  timezone: string;
  status: "CLOSED" | "REOPENED";
  reason: string;
  closed_by: number;
  closed_at: string;
  reopened_by: number | null;
  reopened_at: string | null;
};

export type HrKilometerRate = {
  id: string;
  owner_type: "COMPANY" | "PERSONAL";
  rate_per_km: string;
  currency: string;
  effective_from: string;
  effective_to: string | null;
  definition: string;
  source_type: "DECLARATION" | "LEGAL_SCALE" | "CONTRACT" | "OTHER";
  source_ref: string | null;
  observed_at: string;
  reliability: "DECLARED" | "VERIFIED" | "ESTIMATED";
  supersedes_id: string | null;
  created_by: number;
  created_at: string;
};

const ABSENCE_COLUMNS = `id::text, employee_id::text, absence_date::text, minutes, absence_type,
  timezone, status, reason, source_ref, requested_by, decided_by, decided_at::text,
  created_at::text, updated_at::text`;
const ABSENCE_COLUMNS_A = `a.id::text, a.employee_id::text, a.absence_date::text, a.minutes, a.absence_type,
  a.timezone, a.status, a.reason, a.source_ref, a.requested_by, a.decided_by, a.decided_at::text,
  a.created_at::text, a.updated_at::text`;
const CLOSURE_COLUMNS = `id::text, period_start::text, period_end::text, employee_id::text,
  timezone, status, reason, closed_by, closed_at::text, reopened_by, reopened_at::text`;
const RATE_COLUMNS = `id::text, owner_type::text, rate_per_km::text, currency, effective_from::text,
  effective_to::text, definition, source_type, source_ref, observed_at::text, reliability,
  supersedes_id::text, created_by, created_at::text`;
const RATE_COLUMNS_R = `r.id::text, r.owner_type::text, r.rate_per_km::text, r.currency, r.effective_from::text,
  r.effective_to::text, r.definition, r.source_type, r.source_ref, r.observed_at::text, r.reliability,
  r.supersedes_id::text, r.created_by, r.created_at::text`;

function mapAbsence(row: Record<string, unknown>): HrAbsenceRecord {
  return {
    id: String(row.id), employee_id: String(row.employee_id), absence_date: String(row.absence_date),
    minutes: Number(row.minutes), absence_type: row.absence_type as HrAbsenceRecord["absence_type"],
    timezone: String(row.timezone), status: row.status as HrAbsenceStatus, reason: String(row.reason),
    source_ref: row.source_ref == null ? null : String(row.source_ref), requested_by: Number(row.requested_by),
    decided_by: row.decided_by == null ? null : Number(row.decided_by),
    decided_at: row.decided_at == null ? null : String(row.decided_at), created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function mapClosure(row: Record<string, unknown>): HrPeriodClosure {
  return {
    id: String(row.id), period_start: String(row.period_start), period_end: String(row.period_end),
    employee_id: row.employee_id == null ? null : String(row.employee_id), timezone: String(row.timezone),
    status: row.status as HrPeriodClosure["status"], reason: String(row.reason), closed_by: Number(row.closed_by),
    closed_at: String(row.closed_at), reopened_by: row.reopened_by == null ? null : Number(row.reopened_by),
    reopened_at: row.reopened_at == null ? null : String(row.reopened_at),
  };
}

function mapRate(row: Record<string, unknown>): HrKilometerRate {
  return {
    id: String(row.id), owner_type: row.owner_type as HrKilometerRate["owner_type"],
    rate_per_km: String(row.rate_per_km), currency: String(row.currency).trim(),
    effective_from: String(row.effective_from), effective_to: row.effective_to == null ? null : String(row.effective_to),
    definition: String(row.definition), source_type: row.source_type as HrKilometerRate["source_type"],
    source_ref: row.source_ref == null ? null : String(row.source_ref), observed_at: String(row.observed_at),
    reliability: row.reliability as HrKilometerRate["reliability"],
    supersedes_id: row.supersedes_id == null ? null : String(row.supersedes_id),
    created_by: Number(row.created_by), created_at: String(row.created_at),
  };
}

export async function repoFindActivePeriodClosure(
  employeeId: string,
  from: string,
  to = from,
  q: DbQueryer = pool,
): Promise<HrPeriodClosure | null> {
  const result = await q.query(
    `SELECT ${CLOSURE_COLUMNS}
       FROM public.hr_period_closures
      WHERE status='CLOSED'
        AND (employee_id IS NULL OR employee_id=$1::uuid)
        AND period_start <= $3::date AND period_end >= $2::date
      ORDER BY employee_id NULLS LAST, closed_at DESC LIMIT 1`,
    [employeeId, from, to],
  );
  return result.rows[0] ? mapClosure(result.rows[0]) : null;
}

export async function repoResolveAdjustmentPeriod(
  targetType: "EVENT" | "DAY" | "WEEK",
  targetId: string,
  q: DbQueryer = pool,
): Promise<{ employee_id: string; from: string; to: string } | null> {
  const queries = {
    EVENT: `SELECT employee_id::text, (event_time AT TIME ZONE 'Europe/Paris')::date::text AS from,
                   (event_time AT TIME ZONE 'Europe/Paris')::date::text AS to
              FROM public.hr_time_events WHERE id=$1::uuid`,
    DAY: `SELECT employee_id::text, date::text AS from, date::text AS to
            FROM public.hr_timesheet_days WHERE id=$1::uuid`,
    WEEK: `SELECT employee_id::text, week_start::text AS from, week_end::text AS to
             FROM public.hr_timesheet_weeks WHERE id=$1::uuid`,
  } as const;
  const result = await q.query(queries[targetType], [targetId]);
  const row = result.rows[0];
  return row ? { employee_id: String(row.employee_id), from: String(row.from), to: String(row.to) } : null;
}

export async function repoGetClosurePreflight(
  input: { employee_id: string | null; period_start: string; period_end: string },
  q: DbQueryer = pool,
) {
  const params = [input.employee_id, input.period_start, input.period_end];
  const scope = `($1::uuid IS NULL OR employee_id=$1::uuid)`;
  const dayScope = `($1::uuid IS NULL OR d.employee_id=$1::uuid)`;
  const weekScope = `($1::uuid IS NULL OR w.employee_id=$1::uuid)`;
  const eventScope = `($1::uuid IS NULL OR e.employee_id=$1::uuid)`;
  const [days, weeks, anomalies, adjustments, km, absences] = await Promise.all([
    q.query(`SELECT COUNT(*)::int AS count FROM public.hr_timesheet_days WHERE ${scope} AND date BETWEEN $2::date AND $3::date AND validation_status NOT IN ('VALIDATED','EXPORTED')`, params),
    q.query(`SELECT COUNT(*)::int AS count FROM public.hr_timesheet_weeks WHERE ${scope} AND week_start <= $3::date AND week_end >= $2::date AND validation_status NOT IN ('VALIDATED','EXPORTED')`, params),
    q.query(`SELECT COUNT(*)::int AS count FROM public.hr_time_anomalies WHERE ${scope} AND date BETWEEN $2::date AND $3::date AND resolved_at IS NULL`, params),
    q.query(`SELECT COUNT(*)::int AS count FROM public.hr_time_adjustments a WHERE a.status='REQUESTED' AND EXISTS (
      SELECT 1 FROM public.hr_timesheet_days d WHERE a.target_type='DAY' AND d.id=a.target_id AND ${dayScope} AND d.date BETWEEN $2::date AND $3::date
      UNION ALL SELECT 1 FROM public.hr_timesheet_weeks w WHERE a.target_type='WEEK' AND w.id=a.target_id AND ${weekScope} AND w.week_start <= $3::date AND w.week_end >= $2::date
      UNION ALL SELECT 1 FROM public.hr_time_events e WHERE a.target_type='EVENT' AND e.id=a.target_id AND ${eventScope} AND (e.event_time AT TIME ZONE 'Europe/Paris')::date BETWEEN $2::date AND $3::date
    )`, params),
    q.query(`SELECT COUNT(*)::int AS count FROM public.hr_kilometer_entries WHERE ${scope} AND date BETWEEN $2::date AND $3::date AND status IN ('DRAFT','SUBMITTED')`, params),
    q.query(`SELECT COUNT(*)::int AS count FROM public.hr_absence_records WHERE ${scope} AND absence_date BETWEEN $2::date AND $3::date AND status='REQUESTED'`, params),
  ]);
  return {
    unvalidated_days: Number(days.rows[0]?.count ?? 0), unvalidated_weeks: Number(weeks.rows[0]?.count ?? 0),
    unresolved_anomalies: Number(anomalies.rows[0]?.count ?? 0), pending_adjustments: Number(adjustments.rows[0]?.count ?? 0),
    pending_kilometers: Number(km.rows[0]?.count ?? 0), pending_absences: Number(absences.rows[0]?.count ?? 0),
  };
}

export async function repoCreatePeriodClosure(
  q: DbQueryer,
  input: { period_start: string; period_end: string; employee_id: string | null; timezone: string; reason: string; closed_by: number },
): Promise<HrPeriodClosure> {
  const overlap = await q.query(
    `SELECT id FROM public.hr_period_closures WHERE status='CLOSED'
      AND (employee_id IS NULL OR $1::uuid IS NULL OR employee_id=$1::uuid)
      AND period_start <= $3::date AND period_end >= $2::date LIMIT 1 FOR UPDATE`,
    [input.employee_id, input.period_start, input.period_end],
  );
  if (overlap.rows[0]) throw Object.assign(new Error("period overlap"), { code: "HR_PERIOD_OVERLAP" });
  const result = await q.query(
    `INSERT INTO public.hr_period_closures(period_start,period_end,employee_id,timezone,reason,closed_by)
     VALUES ($1::date,$2::date,$3::uuid,$4,$5,$6) RETURNING ${CLOSURE_COLUMNS}`,
    [input.period_start, input.period_end, input.employee_id, input.timezone, input.reason, input.closed_by],
  );
  return mapClosure(result.rows[0]);
}

export async function repoListPeriodClosures(q: DbQueryer = pool): Promise<HrPeriodClosure[]> {
  const result = await q.query(`SELECT ${CLOSURE_COLUMNS} FROM public.hr_period_closures ORDER BY period_start DESC, closed_at DESC LIMIT 500`);
  return result.rows.map(mapClosure);
}

export async function repoGetPeriodClosure(id: string, q: DbQueryer = pool): Promise<HrPeriodClosure | null> {
  const result = await q.query(`SELECT ${CLOSURE_COLUMNS} FROM public.hr_period_closures WHERE id=$1::uuid LIMIT 1`, [id]);
  return result.rows[0] ? mapClosure(result.rows[0]) : null;
}

export async function repoReopenPeriodClosure(q: DbQueryer, id: string, actorId: number): Promise<HrPeriodClosure | null> {
  const result = await q.query(
    `UPDATE public.hr_period_closures SET status='REOPENED',reopened_by=$2,reopened_at=now()
      WHERE id=$1::uuid AND status='CLOSED' RETURNING ${CLOSURE_COLUMNS}`,
    [id, actorId],
  );
  return result.rows[0] ? mapClosure(result.rows[0]) : null;
}

export async function repoCreateAbsence(
  q: DbQueryer,
  input: Omit<HrAbsenceRecord, "id" | "status" | "decided_by" | "decided_at" | "created_at" | "updated_at">,
): Promise<HrAbsenceRecord> {
  const result = await q.query(
    `INSERT INTO public.hr_absence_records(employee_id,absence_date,minutes,absence_type,timezone,reason,source_ref,requested_by)
     VALUES ($1::uuid,$2::date,$3,$4,$5,$6,$7,$8) RETURNING ${ABSENCE_COLUMNS}`,
    [input.employee_id, input.absence_date, input.minutes, input.absence_type, input.timezone, input.reason, input.source_ref, input.requested_by],
  );
  return mapAbsence(result.rows[0]);
}

export async function repoGetAbsence(id: string, q: DbQueryer = pool): Promise<HrAbsenceRecord | null> {
  const result = await q.query(`SELECT ${ABSENCE_COLUMNS} FROM public.hr_absence_records WHERE id=$1::uuid LIMIT 1`, [id]);
  return result.rows[0] ? mapAbsence(result.rows[0]) : null;
}

export async function repoListAbsences(
  input: { employee_id?: string; manager_user_id?: number; privileged?: boolean; status?: HrAbsenceStatus },
  q: DbQueryer = pool,
): Promise<Array<HrAbsenceRecord & { matricule: string }>> {
  const result = await q.query(
    `SELECT ${ABSENCE_COLUMNS_A}, e.matricule
       FROM public.hr_absence_records a JOIN public.hr_employees e ON e.id=a.employee_id
      WHERE ($1::uuid IS NULL OR a.employee_id=$1::uuid)
        AND ($2::int IS NULL OR $3::boolean OR e.manager_user_id=$2::int)
        AND ($4::text IS NULL OR a.status=$4)
      ORDER BY a.absence_date DESC,a.created_at DESC LIMIT 500`,
    [input.employee_id ?? null, input.manager_user_id ?? null, input.privileged ?? false, input.status ?? null],
  );
  return result.rows.map((row: Record<string, unknown>) => ({ ...mapAbsence(row), matricule: String(row.matricule) }));
}

export async function repoDecideAbsence(
  q: DbQueryer,
  id: string,
  status: "APPROVED" | "REJECTED",
  actorId: number,
): Promise<HrAbsenceRecord | null> {
  const result = await q.query(
    `UPDATE public.hr_absence_records SET status=$2,decided_by=$3,decided_at=now(),updated_at=now()
      WHERE id=$1::uuid AND status='REQUESTED' RETURNING ${ABSENCE_COLUMNS}`,
    [id, status, actorId],
  );
  return result.rows[0] ? mapAbsence(result.rows[0]) : null;
}

export async function repoSumApprovedAbsenceMinutes(
  employeeId: string,
  from: string,
  to: string,
  q: DbQueryer = pool,
): Promise<number> {
  const result = await q.query(
    `SELECT COALESCE(SUM(minutes),0)::int AS minutes FROM public.hr_absence_records
      WHERE employee_id=$1::uuid AND absence_date BETWEEN $2::date AND $3::date AND status='APPROVED'`,
    [employeeId, from, to],
  );
  return Number(result.rows[0]?.minutes ?? 0);
}

export async function repoGetCurrentKilometerRate(ownerType: "COMPANY" | "PERSONAL", q: DbQueryer = pool) {
  const result = await q.query(
    `SELECT ${RATE_COLUMNS} FROM public.hr_kilometer_rate_versions
      WHERE owner_type=$1::public.hr_vehicle_owner AND effective_to IS NULL ORDER BY effective_from DESC LIMIT 1`,
    [ownerType],
  );
  return result.rows[0] ? mapRate(result.rows[0]) : null;
}

export async function repoGetEffectiveKilometerRate(vehicleId: string | null, date: string, q: DbQueryer = pool) {
  if (!vehicleId) return null;
  const result = await q.query(
    `SELECT ${RATE_COLUMNS_R}
       FROM public.hr_vehicles v
       JOIN public.hr_kilometer_rate_versions r ON r.owner_type=v.owner_type
      WHERE v.id=$1::uuid AND r.effective_from <= $2::date
        AND (r.effective_to IS NULL OR r.effective_to >= $2::date)
      ORDER BY r.effective_from DESC LIMIT 1`,
    [vehicleId, date],
  );
  return result.rows[0] ? mapRate(result.rows[0]) : null;
}

export async function repoCreateKilometerRate(
  q: DbQueryer,
  input: Omit<HrKilometerRate, "id" | "effective_to" | "supersedes_id" | "created_at"> & { supersedes_id: string | null },
) {
  if (input.supersedes_id) {
    await q.query(
      `UPDATE public.hr_kilometer_rate_versions SET effective_to=($2::date-INTERVAL '1 day')::date
        WHERE id=$1::uuid AND effective_to IS NULL`,
      [input.supersedes_id, input.effective_from],
    );
  }
  const result = await q.query(
    `INSERT INTO public.hr_kilometer_rate_versions(owner_type,rate_per_km,currency,effective_from,definition,
       source_type,source_ref,observed_at,reliability,supersedes_id,created_by)
     VALUES ($1::public.hr_vehicle_owner,$2::numeric,$3,$4::date,$5,$6,$7,$8::timestamptz,$9,$10::uuid,$11)
     RETURNING ${RATE_COLUMNS}`,
    [input.owner_type, input.rate_per_km, input.currency, input.effective_from, input.definition,
      input.source_type, input.source_ref, input.observed_at, input.reliability, input.supersedes_id, input.created_by],
  );
  return mapRate(result.rows[0]);
}

export async function repoListKilometerRates(q: DbQueryer = pool): Promise<HrKilometerRate[]> {
  const result = await q.query(`SELECT ${RATE_COLUMNS} FROM public.hr_kilometer_rate_versions ORDER BY owner_type,effective_from DESC`);
  return result.rows.map(mapRate);
}

export async function repoGetTeamOperationsQueue(
  input: { manager_user_id: number; privileged: boolean },
  q: DbQueryer = pool,
) {
  const params = [input.privileged, input.manager_user_id];
  const employeeScope = `($1::boolean OR e.manager_user_id=$2::int)`;
  const [days, anomalies, adjustments, absences, duplicates, unpriced] = await Promise.all([
    q.query(`SELECT d.id::text,e.id::text AS employee_id,e.matricule,d.date::text,d.validation_status::text
      FROM public.hr_timesheet_days d JOIN public.hr_employees e ON e.id=d.employee_id
      WHERE ${employeeScope} AND d.date<=CURRENT_DATE AND d.validation_status IN ('DRAFT','TO_REVIEW')
      ORDER BY d.date,e.matricule LIMIT 500`, params),
    q.query(`SELECT a.id::text,e.id::text AS employee_id,e.matricule,a.date::text,a.anomaly_type::text,a.severity::text,a.message
      FROM public.hr_time_anomalies a JOIN public.hr_employees e ON e.id=a.employee_id
      WHERE ${employeeScope} AND a.resolved_at IS NULL ORDER BY a.date,a.severity DESC LIMIT 500`, params),
    q.query(`SELECT a.id::text,e.id::text AS employee_id,e.matricule,a.created_at::text,a.reason
      FROM public.hr_time_adjustments a
      LEFT JOIN public.hr_time_events ev ON a.target_type='EVENT' AND ev.id=a.target_id
      LEFT JOIN public.hr_timesheet_days d ON a.target_type='DAY' AND d.id=a.target_id
      LEFT JOIN public.hr_timesheet_weeks w ON a.target_type='WEEK' AND w.id=a.target_id
      JOIN public.hr_employees e ON e.id=COALESCE(ev.employee_id,d.employee_id,w.employee_id)
      WHERE ${employeeScope} AND a.status='REQUESTED' ORDER BY a.created_at LIMIT 500`, params),
    q.query(`SELECT a.id::text,e.id::text AS employee_id,e.matricule,a.absence_date::text AS date,a.minutes,a.absence_type,a.reason
      FROM public.hr_absence_records a JOIN public.hr_employees e ON e.id=a.employee_id
      WHERE ${employeeScope} AND a.status='REQUESTED' ORDER BY a.absence_date,e.matricule LIMIT 500`, params),
    q.query(`SELECT (array_agg(k.id ORDER BY k.id))[1]::text AS id,e.id::text AS employee_id,e.matricule,k.date::text,k.distance_km::text,
                    count(*)::int AS duplicate_count
      FROM public.hr_kilometer_entries k JOIN public.hr_employees e ON e.id=k.employee_id
      WHERE ${employeeScope} AND k.status<>'REJECTED'
      GROUP BY e.id,e.matricule,k.date,k.distance_km,coalesce(k.start_location,''),coalesce(k.end_location,''),coalesce(k.affaire_id,0)
      HAVING count(*)>1 ORDER BY k.date,e.matricule LIMIT 500`, params),
    q.query(`SELECT k.id::text,e.id::text AS employee_id,e.matricule,k.date::text,k.distance_km::text
      FROM public.hr_kilometer_entries k JOIN public.hr_employees e ON e.id=k.employee_id
      WHERE ${employeeScope} AND k.status='VALIDATED' AND k.cost_amount IS NULL
      ORDER BY k.date,e.matricule LIMIT 500`, params),
  ]);
  return {
    generated_at: new Date().toISOString(),
    unvalidated_timesheets: days.rows,
    unresolved_time_anomalies: anomalies.rows,
    pending_adjustments: adjustments.rows,
    pending_absences: absences.rows,
    duplicate_kilometers: duplicates.rows,
    unpriced_kilometers: unpriced.rows,
  };
}
