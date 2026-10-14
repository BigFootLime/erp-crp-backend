import type { PoolClient } from "pg";
import type { WorkProfile } from "../validators/work-profile.validator";

/** The caller owns the account transaction: no orphan or duplicate RH records. */
export async function createEmployeeWorkProfile(tx: Pick<PoolClient, "query">, userId: number, input: WorkProfile, matricule: string) {
  const employee = await tx.query<{ id: string }>("INSERT INTO public.hr_employees(user_id,matricule) VALUES($1,$2) RETURNING id", [userId,matricule]);
  await tx.query(`INSERT INTO public.hr_employment_contracts(employee_id,contract_type,weekly_hours_target,daily_hours_target,start_date)
    VALUES($1,$2,$3,$4,(now() AT TIME ZONE 'Europe/Paris')::date)`,
  [employee.rows[0].id,input.weekly_hours_target === 35 ? "H35" : input.weekly_hours_target === 39 ? "H39" : "OTHER",input.weekly_hours_target,input.daily_hours_target]);
  for (const day of input.working_days) await tx.query(`INSERT INTO public.hr_work_schedules(employee_id,day_of_week,expected_start,expected_end,expected_break_minutes)
    VALUES($1,$2,$3::time,$4::time,$5)`, [employee.rows[0].id,day === 7 ? 0 : day,input.day_start,input.day_end,input.break_minutes]);
}
