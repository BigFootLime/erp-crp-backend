import pool from "../../../config/database";
import { effectiveRuleSetFromRows, type ContractRow, type HrRuleSet, type RuleSetRow } from "../services/temps-deplacements-rules";
import type { DbQueryer } from "./temps-deplacements.repository";

// -------------------------------------------------------------- T5 : contrats / horaires / règles + résolution

export interface RuleSetInput {
  name: string;
  weekly_target_minutes: number;
  daily_target_minutes: number;
  overtime_threshold_1_minutes: number | null;
  overtime_rate_1: number | null;
  overtime_threshold_2_minutes: number | null;
  overtime_rate_2: number | null;
  rounding_rule: Record<string, unknown>;
  break_rule: Record<string, unknown>;
}
export interface ContractInput {
  employee_id: string;
  contract_type: "H35" | "H39" | "PARTIAL" | "OTHER";
  weekly_hours_target: number;
  daily_hours_target: number | null;
  start_date: string;
  end_date: string | null;
  rule_set_id: string | null;
  active: boolean;
}
export interface ScheduleInput {
  employee_id: string;
  day_of_week: number;
  expected_start: string | null;
  expected_end: string | null;
  expected_break_minutes: number;
  flexible_start_window: number;
  flexible_end_window: number;
  active: boolean;
}

const RS_COLS = `id::text, name, weekly_target_minutes, daily_target_minutes,
  overtime_threshold_1_minutes, overtime_rate_1, overtime_threshold_2_minutes, overtime_rate_2,
  rounding_rule, break_rule, active, created_at::text, updated_at::text`;
const CT_COLS = `id::text, employee_id::text, contract_type::text, weekly_hours_target, daily_hours_target,
  start_date::text, end_date::text, active, rule_set_id::text, created_at::text, updated_at::text`;
const SC_COLS = `id::text, employee_id::text, day_of_week, expected_start::text, expected_end::text,
  expected_break_minutes, flexible_start_window, flexible_end_window, active`;

// ---- Résolution des règles effectives (contrat couvrant la date, puis son rule_set éventuel) ----
export async function repoGetEffectiveRuleSet(employeeId: string, date: string, q: DbQueryer = pool): Promise<HrRuleSet | null> {
  const res = await q.query(
    `SELECT c.id::text, c.contract_type::text, c.weekly_hours_target, c.daily_hours_target, c.rule_set_id::text,
            rs.id::text AS rs_id, rs.name AS rs_name, rs.weekly_target_minutes, rs.daily_target_minutes,
            rs.overtime_threshold_1_minutes, rs.overtime_rate_1, rs.overtime_threshold_2_minutes, rs.overtime_rate_2,
            rs.rounding_rule, rs.break_rule, rs.active AS rs_active
       FROM public.hr_employment_contracts c
       LEFT JOIN public.hr_time_rule_sets rs ON rs.id = c.rule_set_id
      WHERE c.employee_id = $1::uuid
        AND c.start_date <= $2::date AND (c.end_date IS NULL OR c.end_date >= $2::date)
      ORDER BY c.active DESC, c.start_date DESC
      LIMIT 1`,
    [employeeId, date]
  );
  const r = res.rows[0];
  if (!r) return null;
  const contract: ContractRow = {
    id: String(r.id),
    contract_type: String(r.contract_type),
    weekly_hours_target: r.weekly_hours_target,
    daily_hours_target: r.daily_hours_target ?? null,
    rule_set_id: r.rule_set_id ?? null,
  };
  const ruleSet: RuleSetRow | null = r.rs_id
    ? {
        id: String(r.rs_id),
        name: String(r.rs_name),
        weekly_target_minutes: Number(r.weekly_target_minutes),
        daily_target_minutes: Number(r.daily_target_minutes),
        overtime_threshold_1_minutes: r.overtime_threshold_1_minutes ?? null,
        overtime_rate_1: r.overtime_rate_1 ?? null,
        overtime_threshold_2_minutes: r.overtime_threshold_2_minutes ?? null,
        overtime_rate_2: r.overtime_rate_2 ?? null,
        rounding_rule: r.rounding_rule,
        break_rule: r.break_rule,
        active: r.rs_active === true,
      }
    : null;
  return effectiveRuleSetFromRows(contract, ruleSet);
}

// -------------------------------------------------------------- Employés (lecture pour pickers admin)
export async function repoListEmployees(q: DbQueryer = pool) {
  const res = await q.query(
    `SELECT e.id::text, e.matricule, e.service, e.status::text, e.user_id, e.manager_user_id,
            u.name, u.surname
       FROM public.hr_employees e
       LEFT JOIN public.users u ON u.id = e.user_id
      ORDER BY e.matricule ASC LIMIT 1000`
  );
  return res.rows;
}

// -------------------------------------------------------------- Rule sets (CRUD)
export async function repoListRuleSets(q: DbQueryer = pool) {
  const res = await q.query(`SELECT ${RS_COLS} FROM public.hr_time_rule_sets ORDER BY active DESC, name ASC LIMIT 500`);
  return res.rows;
}
export async function repoGetRuleSetById(id: string, q: DbQueryer = pool) {
  const res = await q.query(`SELECT ${RS_COLS} FROM public.hr_time_rule_sets WHERE id = $1::uuid LIMIT 1`, [id]);
  return res.rows[0] ?? null;
}
export async function repoInsertRuleSet(q: DbQueryer, i: RuleSetInput) {
  const res = await q.query(
    `INSERT INTO public.hr_time_rule_sets
       (name, weekly_target_minutes, daily_target_minutes, overtime_threshold_1_minutes, overtime_rate_1,
        overtime_threshold_2_minutes, overtime_rate_2, rounding_rule, break_rule)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb) RETURNING ${RS_COLS}`,
    [i.name, i.weekly_target_minutes, i.daily_target_minutes, i.overtime_threshold_1_minutes, i.overtime_rate_1,
     i.overtime_threshold_2_minutes, i.overtime_rate_2, JSON.stringify(i.rounding_rule ?? {}), JSON.stringify(i.break_rule ?? {})]
  );
  return res.rows[0];
}
export async function repoUpdateRuleSet(q: DbQueryer, id: string, i: RuleSetInput) {
  const res = await q.query(
    `UPDATE public.hr_time_rule_sets SET
       name=$2, weekly_target_minutes=$3, daily_target_minutes=$4, overtime_threshold_1_minutes=$5, overtime_rate_1=$6,
       overtime_threshold_2_minutes=$7, overtime_rate_2=$8, rounding_rule=$9::jsonb, break_rule=$10::jsonb, updated_at=now()
     WHERE id=$1::uuid RETURNING ${RS_COLS}`,
    [id, i.name, i.weekly_target_minutes, i.daily_target_minutes, i.overtime_threshold_1_minutes, i.overtime_rate_1,
     i.overtime_threshold_2_minutes, i.overtime_rate_2, JSON.stringify(i.rounding_rule ?? {}), JSON.stringify(i.break_rule ?? {})]
  );
  return res.rows[0] ?? null;
}
export async function repoSetRuleSetActive(q: DbQueryer, id: string, active: boolean) {
  const res = await q.query(
    `UPDATE public.hr_time_rule_sets SET active=$2, updated_at=now() WHERE id=$1::uuid RETURNING ${RS_COLS}`,
    [id, active]
  );
  return res.rows[0] ?? null;
}

// -------------------------------------------------------------- Contrats (CRUD ; 1 seul actif/employé)
export async function repoListContracts(q: DbQueryer, employeeId?: string) {
  if (employeeId) {
    const res = await q.query(`SELECT ${CT_COLS} FROM public.hr_employment_contracts WHERE employee_id=$1::uuid ORDER BY start_date DESC LIMIT 500`, [employeeId]);
    return res.rows;
  }
  const res = await q.query(`SELECT ${CT_COLS} FROM public.hr_employment_contracts ORDER BY start_date DESC LIMIT 500`);
  return res.rows;
}
export async function repoGetContractById(id: string, q: DbQueryer = pool) {
  const res = await q.query(`SELECT ${CT_COLS} FROM public.hr_employment_contracts WHERE id=$1::uuid LIMIT 1`, [id]);
  return res.rows[0] ?? null;
}
export async function repoInsertContract(q: DbQueryer, i: ContractInput) {
  const res = await q.query(
    `INSERT INTO public.hr_employment_contracts
       (employee_id, contract_type, weekly_hours_target, daily_hours_target, start_date, end_date, rule_set_id, active)
     VALUES ($1::uuid,$2::hr_contract_type,$3,$4,$5::date,$6::date,$7,$8) RETURNING ${CT_COLS}`,
    [i.employee_id, i.contract_type, i.weekly_hours_target, i.daily_hours_target, i.start_date, i.end_date, i.rule_set_id, i.active]
  );
  return res.rows[0];
}
export async function repoUpdateContract(q: DbQueryer, id: string, i: ContractInput) {
  const res = await q.query(
    `UPDATE public.hr_employment_contracts SET
       contract_type=$2::hr_contract_type, weekly_hours_target=$3, daily_hours_target=$4,
       start_date=$5::date, end_date=$6::date, rule_set_id=$7, active=$8, updated_at=now()
     WHERE id=$1::uuid RETURNING ${CT_COLS}`,
    [id, i.contract_type, i.weekly_hours_target, i.daily_hours_target, i.start_date, i.end_date, i.rule_set_id, i.active]
  );
  return res.rows[0] ?? null;
}
export async function repoSetContractActive(q: DbQueryer, id: string, active: boolean) {
  const res = await q.query(`UPDATE public.hr_employment_contracts SET active=$2, updated_at=now() WHERE id=$1::uuid RETURNING ${CT_COLS}`, [id, active]);
  return res.rows[0] ?? null;
}

// -------------------------------------------------------------- Horaires types (CRUD)
export async function repoListSchedules(q: DbQueryer, employeeId: string) {
  const res = await q.query(`SELECT ${SC_COLS} FROM public.hr_work_schedules WHERE employee_id=$1::uuid ORDER BY day_of_week ASC LIMIT 500`, [employeeId]);
  return res.rows;
}
export async function repoInsertSchedule(q: DbQueryer, i: ScheduleInput) {
  const res = await q.query(
    `INSERT INTO public.hr_work_schedules
       (employee_id, day_of_week, expected_start, expected_end, expected_break_minutes, flexible_start_window, flexible_end_window, active)
     VALUES ($1::uuid,$2,$3::time,$4::time,$5,$6,$7,$8) RETURNING ${SC_COLS}`,
    [i.employee_id, i.day_of_week, i.expected_start, i.expected_end, i.expected_break_minutes, i.flexible_start_window, i.flexible_end_window, i.active]
  );
  return res.rows[0];
}
export async function repoUpdateSchedule(q: DbQueryer, id: string, i: ScheduleInput) {
  const res = await q.query(
    `UPDATE public.hr_work_schedules SET
       day_of_week=$2, expected_start=$3::time, expected_end=$4::time, expected_break_minutes=$5,
       flexible_start_window=$6, flexible_end_window=$7, active=$8
     WHERE id=$1::uuid RETURNING ${SC_COLS}`,
    [id, i.day_of_week, i.expected_start, i.expected_end, i.expected_break_minutes, i.flexible_start_window, i.flexible_end_window, i.active]
  );
  return res.rows[0] ?? null;
}
export async function repoDeleteSchedule(q: DbQueryer, id: string): Promise<boolean> {
  const res = await q.query(`DELETE FROM public.hr_work_schedules WHERE id=$1::uuid`, [id]);
  return (res.rowCount ?? 0) > 0;
}

// -------------------------------------------------------------- Persistance du relevé hebdo (agrégat)
export async function repoUpsertTimesheetWeek(
  q: DbQueryer,
  w: { employee_id: string; week_start: string; week_end: string; contract_minutes: number; worked_minutes: number; overtime_25_minutes: number; overtime_50_minutes: number; absence_minutes: number }
): Promise<void> {
  await q.query(
    `INSERT INTO public.hr_timesheet_weeks
       (employee_id, week_start, week_end, contract_minutes, worked_minutes, overtime_25_minutes, overtime_50_minutes, absence_minutes)
     VALUES ($1::uuid,$2::date,$3::date,$4,$5,$6,$7,$8)
     ON CONFLICT (employee_id, week_start) DO UPDATE SET
       week_end=EXCLUDED.week_end, contract_minutes=EXCLUDED.contract_minutes, worked_minutes=EXCLUDED.worked_minutes,
       overtime_25_minutes=EXCLUDED.overtime_25_minutes, overtime_50_minutes=EXCLUDED.overtime_50_minutes,
       absence_minutes=EXCLUDED.absence_minutes, updated_at=now()
     WHERE public.hr_timesheet_weeks.validation_status = 'DRAFT'`,
    [w.employee_id, w.week_start, w.week_end, w.contract_minutes, w.worked_minutes, w.overtime_25_minutes, w.overtime_50_minutes, w.absence_minutes]
  );
}
