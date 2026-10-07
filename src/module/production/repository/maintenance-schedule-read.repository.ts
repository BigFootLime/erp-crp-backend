import type { PoolClient } from 'pg';
import pool from '../../../config/database';
import { HttpError } from '../../../utils/httpError';
import { maintenanceScheduleDefinitionSchema } from '../validators/maintenance-schedule.validators';
import type { MaintenanceSchedule, MaintenanceSlot, MaintenanceOccurrence } from '../types/maintenance-schedule.types';
type Queryer = Pick<PoolClient, 'query'>;
const iso = (value: string) => new Date(value).toISOString();
export const MAINTENANCE_SCHEDULE_EXPANSION_SQL = `WITH definitions AS (
 SELECT x.id::uuid AS id,x.version,x.definition FROM jsonb_to_recordset($1::jsonb) AS x(id text,version integer,definition jsonb)
), local_slots AS (
 SELECT d.id,d.version,d.definition,t.target,
  ((d.definition->>'start_date')::date+day.n+(d.definition->>'start_time')::time) AS local_start,
  NULL::timestamp AS local_end,(d.definition->>'duration_minutes')::integer AS duration
 FROM definitions d CROSS JOIN LATERAL jsonb_array_elements(d.definition->'targets') t(target)
 CROSS JOIN LATERAL generate_series(0,(d.definition->>'end_date')::date-(d.definition->>'start_date')::date) day(n)
 WHERE d.definition->>'kind'='LEVEL_1_WEEKLY'
  AND extract(isodow FROM (d.definition->>'start_date')::date+day.n)=(d.definition->>'weekday')::integer
 UNION ALL
 SELECT d.id,d.version,d.definition,t.target,
  (t.target->>'start_date')::date+(t.target->>'start_time')::time,
  (t.target->>'start_date')::date+(t.target->>'start_time')::time+interval '7 days',NULL::integer
 FROM definitions d CROSS JOIN LATERAL jsonb_array_elements(d.definition->'entries') t(target)
 WHERE d.definition->>'kind'='LEVEL_2_ANNUAL'
), instants AS (
 SELECT *,local_start AT TIME ZONE 'Europe/Paris' AS start_ts,
  CASE WHEN local_end IS NULL THEN (local_start AT TIME ZONE 'Europe/Paris')+duration*interval '1 minute'
   ELSE local_end AT TIME ZONE 'Europe/Paris' END AS end_ts FROM local_slots
)
SELECT id::text AS schedule_id,version AS schedule_version,definition->>'kind' AS kind,definition->>'title' AS title,definition->>'notes' AS notes,
 target->>'machine_id' AS machine_id,start_ts::text,end_ts::text,
 ((start_ts AT TIME ZONE 'Europe/Paris')=local_start AND ((start_ts-interval '1 hour') AT TIME ZONE 'Europe/Paris')<>local_start
  AND ((start_ts+interval '1 hour') AT TIME ZONE 'Europe/Paris')<>local_start
  AND (local_end IS NULL OR ((end_ts AT TIME ZONE 'Europe/Paris')=local_end
   AND ((end_ts-interval '1 hour') AT TIME ZONE 'Europe/Paris')<>local_end AND ((end_ts+interval '1 hour') AT TIME ZONE 'Europe/Paris')<>local_end))) AS local_valid,
 COALESCE(target->>'execution_mode','INTERNAL') AS execution_mode,target->>'provider_id' AS provider_id,
 (target->>'responsible_user_id')::integer AS responsible_user_id,target->>'maintenance_plan_id' AS maintenance_plan_id
 FROM instants ORDER BY machine_id,start_ts,id LIMIT 10001`;
export async function readMaintenanceSchedules(tx: Queryer, lock = false): Promise<MaintenanceSchedule[]> {
    const result = await tx.query<MaintenanceSchedule>(`SELECT s.id::text,s.kind,s.version,s.enabled,r.definition,r.reason,s.updated_at::text
 FROM public.production_maintenance_schedules s JOIN public.production_maintenance_schedule_revisions r ON r.schedule_id=s.id AND r.version=s.version
 ORDER BY s.id ${lock ? 'FOR UPDATE OF s' : ''}`);
    return result.rows.map(s => {
        const parsed = maintenanceScheduleDefinitionSchema.safeParse(s.definition);
        if (!parsed.success)
            throw new HttpError(503, 'MAINTENANCE_SCHEDULE_INVALID', 'Une définition enregistrée est incohérente. Faites vérifier ce référentiel.', { schedule_id: s.id });
        return { ...s, definition: parsed.data };
    });
}
export async function expandMaintenanceSlots(tx: Queryer, rules: MaintenanceSchedule[]): Promise<MaintenanceSlot[]> {
    const result = await tx.query<MaintenanceSlot>(MAINTENANCE_SCHEDULE_EXPANSION_SQL, [JSON.stringify(rules.filter(r => r.enabled).map(({ id, version, definition }) => ({ id, version, definition })))]);
    if (result.rows.length > 10000)
        throw new HttpError(413, 'MAINTENANCE_SLOT_LIMIT', 'L’aperçu dépasse 10 000 créneaux ; réduisez la période ou le nombre de machines.');
    return result.rows.map(s => ({ ...s, start_ts: iso(s.start_ts), end_ts: iso(s.end_ts) }));
}
export async function readMaintenanceOccurrences(tx: Queryer, lock = false): Promise<MaintenanceOccurrence[]> {
    const result = await tx.query<MaintenanceOccurrence>(`SELECT o.id::text,o.schedule_id::text,o.schedule_version,o.machine_id::text,
 o.unavailability_id::text,u.planning_event_id::text,e.status::text,e.start_ts::text,e.end_ts::text,
 (e.archived_at IS NOT NULL OR u.archived_at IS NOT NULL) AS archived,o.provider_id::text,o.responsible_user_id,o.snapshot,
 r.definition->>'kind' AS kind,r.definition->>'title' AS title,r.definition->>'notes' AS notes,
 u.maintenance_plan_id::text,o.snapshot->>'execution_mode' AS execution_mode,true AS local_valid
 FROM public.production_maintenance_schedule_occurrences o
 JOIN public.production_maintenance_schedule_revisions r ON r.schedule_id=o.schedule_id AND r.version=o.schedule_version
 JOIN public.production_machine_unavailability u ON u.id=o.unavailability_id JOIN public.planning_events e ON e.id=u.planning_event_id
 WHERE e.end_ts>statement_timestamp() OR e.status='IN_PROGRESS' ORDER BY e.start_ts,o.id LIMIT 10001 ${lock ? 'FOR UPDATE OF u,e' : ''}`);
    if (result.rows.length > 10000)
        throw new HttpError(413, 'MAINTENANCE_OCCURRENCE_LIMIT', 'Trop de créneaux futurs ; réduisez les règles à publier.');
    return result.rows.map(s => ({ ...s, start_ts: iso(s.start_ts), end_ts: iso(s.end_ts) }));
}
export async function readMaintenanceReferences(tx: Queryer) {
    const [machines, providers, users, plans] = await Promise.all([
        tx.query<{
            id: string;
            name: string;
            code: string;
            status: string;
            scheduling_enabled: boolean;
        }>("SELECT id::text,name,code,status::text,scheduling_enabled FROM public.machines WHERE archived_at IS NULL ORDER BY name,id"),
        tx.query<{
            id: string;
            nom: string;
            code: string;
        }>('SELECT id::text,nom,code FROM public.fournisseurs WHERE actif ORDER BY nom,id'),
        tx.query<{
            id: number;
            name: string;
            username: string;
        }>(`SELECT id::int,username,concat_ws(' ',NULLIF(name,''),NULLIF(surname,'')) AS name FROM public.users WHERE COALESCE(NULLIF(lower(trim(status)),''),'active') NOT IN ('inactive','blocked','suspended') ORDER BY username`),
        tx.query<{
            id: string;
            machine_id: string;
            title: string;
        }>("SELECT id::text,machine_id::text,title FROM public.production_machine_maintenance_plans WHERE archived_at IS NULL AND status='ACTIVE' ORDER BY title,id"),
    ]);
    return { machines: machines.rows, providers: providers.rows, users: users.rows, plans: plans.rows };
}
export async function readMaintenanceCalendarWorkspace(canManage: boolean) {
    const tx = await pool.connect();
    try {
        await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const [schedules, refs, history, clock] = await Promise.all([
            readMaintenanceSchedules(tx), readMaintenanceReferences(tx),
            tx.query(`SELECT o.schedule_id::text,count(*)::int AS occurrence_count,count(*) FILTER(WHERE e.end_ts<=now())::int AS past_count
    FROM public.production_maintenance_schedule_occurrences o JOIN public.production_machine_unavailability u ON u.id=o.unavailability_id
    JOIN public.planning_events e ON e.id=u.planning_event_id GROUP BY o.schedule_id`),
            tx.query<{
                now: string;
                today: string;
            }>("SELECT clock_timestamp()::text AS now,(now() AT TIME ZONE 'Europe/Paris')::date::text AS today"),
        ]);
        await tx.query('COMMIT');
        return { can_manage: canManage, timezone: 'Europe/Paris', ...refs, schedules, history: history.rows, ...clock.rows[0] };
    }
    catch (error) {
        await tx.query('ROLLBACK');
        throw error;
    }
    finally {
        tx.release();
    }
}
