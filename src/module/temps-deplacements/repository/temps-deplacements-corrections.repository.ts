import pool from "../../../config/database";
import type { HrEmployeeLite, HrTimeAnomaly } from "../types/temps-deplacements.types";
import type { DbQueryer } from "./temps-deplacements.repository";

// -------------------------------------------------------------- T4 : corrections + validation
// Réutilise DbQueryer / withTransaction / insertAuditLog du repository T2.

export type HrAdjustmentTarget = "EVENT" | "DAY" | "WEEK";
export type HrAdjustmentStatus = "REQUESTED" | "APPROVED" | "REJECTED";
export type HrValidationStatus = "DRAFT" | "TO_REVIEW" | "VALIDATED" | "EXPORTED";

export type HrAdjustment = {
  id: string;
  target_type: HrAdjustmentTarget;
  target_id: string;
  reason: string;
  status: HrAdjustmentStatus;
  requested_by: number;
  approved_by: number | null;
  created_at: string;
  approved_at: string | null;
};
export type HrAdjustmentWithEmployee = HrAdjustment & {
  employee_id: string;
  matricule: string;
  service: string | null;
};

const ADJ_COLS =
  `id::text, target_type::text, target_id::text, reason, status::text, requested_by, approved_by, created_at::text, approved_at::text`;
const EMP_COLS = `id::text, user_id, matricule, service, manager_user_id, status::text`;

function mapAdj(r: Record<string, unknown>): HrAdjustment {
  return {
    id: String(r.id),
    target_type: r.target_type as HrAdjustmentTarget,
    target_id: String(r.target_id),
    reason: String(r.reason),
    status: r.status as HrAdjustmentStatus,
    requested_by: Number(r.requested_by),
    approved_by: r.approved_by === null || r.approved_by === undefined ? null : Number(r.approved_by),
    created_at: String(r.created_at),
    approved_at: (r.approved_at as string | null) ?? null,
  };
}

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

// Table propriétaire de la cible, par type (whitelist = enum hr_adjustment_target ⇒ pas d'injection).
const TARGET_TABLE: Record<HrAdjustmentTarget, string> = {
  EVENT: "hr_time_events",
  DAY: "hr_timesheet_days",
  WEEK: "hr_timesheet_weeks",
};

// Résout l'employé (uuid) propriétaire d'une cible de correction. null si la cible n'existe pas.
export async function repoResolveTargetEmployeeId(
  targetType: HrAdjustmentTarget,
  targetId: string,
  q: DbQueryer = pool
): Promise<string | null> {
  const res = await q.query(
    `SELECT employee_id::text FROM public.${TARGET_TABLE[targetType]} WHERE id = $1::uuid LIMIT 1`,
    [targetId]
  );
  return res.rows[0] ? String(res.rows[0].employee_id) : null;
}

export async function repoCreateAdjustment(
  q: DbQueryer,
  input: {
    target_type: HrAdjustmentTarget;
    target_id: string;
    reason: string;
    old_value?: Record<string, unknown> | null;
    new_value?: Record<string, unknown> | null;
    requested_by: number;
  }
): Promise<HrAdjustment> {
  const res = await q.query(
    `INSERT INTO public.hr_time_adjustments
       (target_type, target_id, old_value_json, new_value_json, reason, requested_by, status)
     VALUES ($1::hr_adjustment_target, $2::uuid, $3::jsonb, $4::jsonb, $5, $6, 'REQUESTED'::hr_adjustment_status)
     RETURNING ${ADJ_COLS}`,
    [
      input.target_type,
      input.target_id,
      JSON.stringify(input.old_value ?? null),
      JSON.stringify(input.new_value ?? null),
      input.reason,
      input.requested_by,
    ]
  );
  return mapAdj(res.rows[0]);
}

export async function repoGetAdjustmentById(id: string, q: DbQueryer = pool): Promise<HrAdjustment | null> {
  const res = await q.query(`SELECT ${ADJ_COLS} FROM public.hr_time_adjustments WHERE id = $1::uuid LIMIT 1`, [id]);
  return res.rows[0] ? mapAdj(res.rows[0]) : null;
}

// Transition REQUESTED → APPROVED|REJECTED. Ne modifie QUE si encore en attente (retourne null sinon).
// La contrainte DB hr_time_adjustments_no_self_approve_ck (approved_by <> requested_by) reste un garde-fou.
export async function repoDecideAdjustment(
  q: DbQueryer,
  id: string,
  status: Exclude<HrAdjustmentStatus, "REQUESTED">,
  approvedBy: number
): Promise<HrAdjustment | null> {
  const res = await q.query(
    `UPDATE public.hr_time_adjustments
        SET status = $2::hr_adjustment_status, approved_by = $3, approved_at = now()
      WHERE id = $1::uuid AND status = 'REQUESTED'::hr_adjustment_status
      RETURNING ${ADJ_COLS}`,
    [id, status, approvedBy]
  );
  return res.rows[0] ? mapAdj(res.rows[0]) : null;
}

// Demandes en attente : périmètre manager, OU toutes si privilégié (RH/Direction/Admin).
export async function repoListTeamAdjustments(
  filters: { managerUserId: number; isPrivileged: boolean; status?: HrAdjustmentStatus },
  q: DbQueryer = pool
): Promise<HrAdjustmentWithEmployee[]> {
  const res = await q.query(
    `SELECT a.id::text, a.target_type::text, a.target_id::text, a.reason, a.status::text,
            a.requested_by, a.approved_by, a.created_at::text, a.approved_at::text,
            emp.id::text AS employee_id, emp.matricule, emp.service
       FROM public.hr_time_adjustments a
       LEFT JOIN public.hr_time_events ev     ON a.target_type = 'EVENT' AND ev.id = a.target_id
       LEFT JOIN public.hr_timesheet_days td  ON a.target_type = 'DAY'   AND td.id = a.target_id
       LEFT JOIN public.hr_timesheet_weeks tw ON a.target_type = 'WEEK'  AND tw.id = a.target_id
       JOIN public.hr_employees emp ON emp.id = COALESCE(ev.employee_id, td.employee_id, tw.employee_id)
      WHERE a.status = $1::hr_adjustment_status
        AND ($2::boolean OR emp.manager_user_id = $3::int)
      ORDER BY a.created_at DESC
      LIMIT 500`,
    [filters.status ?? "REQUESTED", filters.isPrivileged, filters.managerUserId]
  );
  return res.rows.map((r) => ({
    ...mapAdj(r),
    employee_id: String(r.employee_id),
    matricule: String(r.matricule),
    service: (r.service as string | null) ?? null,
  }));
}

// -------------------------------------------------------------- Validation jour / semaine
export type TimesheetRef = { id: string; employee_id: string; validation_status: HrValidationStatus };

export async function repoGetTimesheetDayById(id: string, q: DbQueryer = pool): Promise<TimesheetRef | null> {
  const res = await q.query(
    `SELECT id::text, employee_id::text, validation_status::text FROM public.hr_timesheet_days WHERE id = $1::uuid LIMIT 1`,
    [id]
  );
  const r = res.rows[0];
  return r ? { id: String(r.id), employee_id: String(r.employee_id), validation_status: r.validation_status as HrValidationStatus } : null;
}

export async function repoGetTimesheetWeekById(id: string, q: DbQueryer = pool): Promise<TimesheetRef | null> {
  const res = await q.query(
    `SELECT id::text, employee_id::text, validation_status::text FROM public.hr_timesheet_weeks WHERE id = $1::uuid LIMIT 1`,
    [id]
  );
  const r = res.rows[0];
  return r ? { id: String(r.id), employee_id: String(r.employee_id), validation_status: r.validation_status as HrValidationStatus } : null;
}

// VALIDATE : uniquement depuis DRAFT/TO_REVIEW (retourne null si déjà VALIDATED/EXPORTED — non rejouable).
export async function repoSetDayValidation(
  q: DbQueryer,
  id: string,
  status: "VALIDATED" | "TO_REVIEW",
  validatedBy: number
): Promise<TimesheetRef | null> {
  const res = await q.query(
    `UPDATE public.hr_timesheet_days
        SET validation_status = $2::hr_validation_status,
            validated_by = $3, validated_at = now(), updated_at = now()
      WHERE id = $1::uuid AND validation_status IN ('DRAFT','TO_REVIEW')
      RETURNING id::text, employee_id::text, validation_status::text`,
    [id, status, validatedBy]
  );
  const r = res.rows[0];
  return r ? { id: String(r.id), employee_id: String(r.employee_id), validation_status: r.validation_status as HrValidationStatus } : null;
}

export async function repoSetWeekValidation(
  q: DbQueryer,
  id: string,
  status: "VALIDATED" | "TO_REVIEW",
  validatedBy: number
): Promise<TimesheetRef | null> {
  const res = await q.query(
    `UPDATE public.hr_timesheet_weeks
        SET validation_status = $2::hr_validation_status,
            validated_by = $3, validated_at = now(), updated_at = now()
      WHERE id = $1::uuid AND validation_status IN ('DRAFT','TO_REVIEW')
      RETURNING id::text, employee_id::text, validation_status::text`,
    [id, status, validatedBy]
  );
  const r = res.rows[0];
  return r ? { id: String(r.id), employee_id: String(r.employee_id), validation_status: r.validation_status as HrValidationStatus } : null;
}

// -------------------------------------------------------------- Périmètre équipe
export async function repoListTeamEmployees(
  filters: { managerUserId: number; isPrivileged: boolean },
  q: DbQueryer = pool
): Promise<HrEmployeeLite[]> {
  const res = await q.query(
    `SELECT ${EMP_COLS} FROM public.hr_employees
      WHERE status = 'ACTIVE' AND ($1::boolean OR manager_user_id = $2::int)
      ORDER BY matricule ASC LIMIT 500`,
    [filters.isPrivileged, filters.managerUserId]
  );
  return res.rows.map(mapEmployee);
}

export async function repoListTeamAnomaliesForDate(
  filters: { managerUserId: number; isPrivileged: boolean; date: string },
  q: DbQueryer = pool
): Promise<Array<HrTimeAnomaly & { matricule: string }>> {
  const res = await q.query(
    `SELECT an.id::text, an.employee_id::text, an.date::text, an.anomaly_type::text, an.severity::text,
            an.message, an.resolved_by, an.resolved_at::text, an.created_at::text, emp.matricule
       FROM public.hr_time_anomalies an
       JOIN public.hr_employees emp ON emp.id = an.employee_id
      WHERE an.date = $1::date AND ($2::boolean OR emp.manager_user_id = $3::int)
      ORDER BY an.severity DESC, an.created_at DESC
      LIMIT 500`,
    [filters.date, filters.isPrivileged, filters.managerUserId]
  );
  return res.rows.map((r) => ({
    id: String(r.id),
    employee_id: String(r.employee_id),
    date: String(r.date),
    anomaly_type: r.anomaly_type as HrTimeAnomaly["anomaly_type"],
    severity: r.severity as HrTimeAnomaly["severity"],
    message: (r.message as string | null) ?? null,
    resolved_by: r.resolved_by === null || r.resolved_by === undefined ? null : Number(r.resolved_by),
    resolved_at: (r.resolved_at as string | null) ?? null,
    created_at: String(r.created_at),
    matricule: String(r.matricule),
  }));
}
