import type {Pool,PoolClient} from 'pg';
import {workProfileSchema} from '../module/auth/validators/work-profile.validator';
export async function directoryWorkProfile(db:Pick<Pool|PoolClient,'query'>,userId:number){
 const row=(await db.query(`SELECT c.start_date::text AS start_date,jsonb_build_object(
  'weekly_hours_target',c.weekly_hours_target::float,'daily_hours_target',c.daily_hours_target::float,
  'day_start',(SELECT to_char(min(expected_start),'HH24:MI') FROM public.hr_work_schedules WHERE employee_id=e.id AND active),
  'day_end',(SELECT to_char(max(expected_end),'HH24:MI') FROM public.hr_work_schedules WHERE employee_id=e.id AND active),
  'break_minutes',(SELECT min(expected_break_minutes) FROM public.hr_work_schedules WHERE employee_id=e.id AND active),
  'working_days',(SELECT jsonb_agg(CASE WHEN day_of_week=0 THEN 7 ELSE day_of_week END ORDER BY day_of_week) FROM public.hr_work_schedules WHERE employee_id=e.id AND active)) AS profile
  FROM public.hr_employees e JOIN public.hr_employment_contracts c ON c.employee_id=e.id AND c.active
  WHERE e.user_id=$1 AND e.status='ACTIVE' ORDER BY c.start_date DESC LIMIT 1`,[userId])).rows[0];
 if(!row)return {work_profile:null,work_profile_start_date:null};
 const parsed=workProfileSchema.safeParse(row.profile);return parsed.success?{work_profile:parsed.data,work_profile_start_date:row.start_date}:{work_profile:null,work_profile_start_date:null};
}
