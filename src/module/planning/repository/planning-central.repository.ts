import type { PoolClient } from "pg";
import { createHash } from "node:crypto";
import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { estimateDuration, type DurationObservation } from "../domain/central-estimation";
import { expandCalendar, type CalendarDefinition } from "../domain/central-calendar";
import type { CentralSnapshot, CentralTask, Dependency, Resource } from "../types/planning-central.types";
import type { CentralWindow } from "../validators/planning-central.validators";
import {readForecastState} from './planning-forecast.repository';

export type CentralQuery = Pick<PoolClient, "query">;
type Row = Record<string, unknown>;
const str = (v: unknown): string | null => v === null || v === undefined ? null : String(v);
const num = (v: unknown): number => Number(v ?? 0);
const instant = (v: unknown): string | null => v == null ? null : new Date(String(v)).toISOString();
const strings = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
const interval = (a: unknown, b: unknown) => a && b ? { start: instant(a)!, end: instant(b)! } : null;
export async function readCentralSettings(tx: CentralQuery = pool) {
  const { rows } = await tx.query<{ activation: CentralSnapshot["activation"]; revision: string }>(
    "SELECT activation,revision::text FROM public.planning_central_settings WHERE singleton");
  if (!rows[0]) throw new HttpError(503, "PLANNING_NOT_CONFIGURED", "Le planning central n'est pas configuré.");
  return rows[0];
}

/** Read-only adapters: committed machine slots still belong to planning_events; quantities to production. */
const TASK_QUERY = `
WITH operation_rows AS (
 SELECT t.id,t.operation_id::text,t.programming_id::text,t.draft_of_id,
   t.version,t.envelope_minutes,t.earliest_start,t.forecast_start,t.forecast_end,t.locked,t.blockers,t.configuration_key,
   o.id AS of_id,o.commande_id AS order_id,o.numero AS of_number,pt.code_piece AS reference,
   o.piece_technique_version_id::text AS revision,op.designation AS label,op.phase,
   CASE frozen.value->>'type_operation' WHEN 'DECOUPE' THEN 'cutting' WHEN 'SOUS_TRAITANCE' THEN 'external' ELSE 'machines' END AS view,
   cc.order_type='INTERNE' AS internal,cc.internal_order_purpose AS internal_purpose,
   o.quantite_lancee AS quantity,COALESCE(q.good,0) AS good,COALESCE(q.scrap,0) AS scrap,COALESCE(q.rework,0) AS rework,
   0::numeric AS released,
   CASE WHEN e.machine_id IS NOT NULL THEN 'machine:'||e.machine_id::text
        WHEN e.poste_id IS NOT NULL THEN 'poste:'||e.poste_id::text
        WHEN op.machine_id IS NOT NULL THEN 'machine:'||op.machine_id::text
        WHEN op.poste_id IS NOT NULL THEN 'poste:'||op.poste_id::text END AS resource_id,
   e.start_ts AS committed_start,e.end_ts AS committed_end,op.started_at AS actual_start,op.ended_at AS actual_end,
   op.status::text AS status,o.technical_readiness AS readiness,
   CASE WHEN cc.order_type='INTERNE' THEN COALESCE(cl.delai_interne,cl.delai_client)::text ELSE cl.delai_client::text END AS due,
   CASE o.priority::text WHEN 'CRITICAL' THEN 3 WHEN 'HIGH' THEN 2 WHEN 'LOW' THEN 0 ELSE 1 END AS priority,
   op.created_at,op.updated_at,op.tp*60 AS setup_minutes,op.tf_unit*op.qte*op.coef*60 AS unit_minutes,
   'OPERATION'::text AS source
 FROM public.planning_tasks t
 JOIN public.of_operations op ON op.id=t.operation_id
 JOIN public.ordres_fabrication o ON o.id=op.of_id
 JOIN public.pieces_techniques pt ON pt.id=o.piece_technique_id
 LEFT JOIN public.commande_client cc ON cc.id=o.commande_id
 LEFT JOIN public.commande_ligne cl ON cl.id=o.commande_ligne_id
 LEFT JOIN LATERAL (SELECT value FROM jsonb_array_elements(COALESCE(o.technical_snapshot->'operations','[]'::jsonb))
   WHERE value->>'phase'=op.phase::text LIMIT 1) frozen ON true
 LEFT JOIN LATERAL (SELECT * FROM public.planning_events WHERE of_operation_id=op.id AND archived_at IS NULL
   AND status<>'CANCELLED' ORDER BY start_ts,id LIMIT 1) e ON true
 LEFT JOIN LATERAL (SELECT sum(qty_good) AS good,sum(qty_scrap) AS scrap,sum(qty_rework) AS rework
   FROM public.production_quantity_declarations WHERE operation_id=op.id) q ON true
 WHERE o.statut<>'ANNULE' AND op.status::text<>'CANCELLED'
   AND(op.revision_id IS NULL OR EXISTS(SELECT 1 FROM public.of_revisions r WHERE r.id=op.revision_id AND r.statut='ACTIVE'))
   AND NOT EXISTS(SELECT 1 FROM public.production_consolidation_allocations a WHERE a.source_of_id=o.id AND a.state='ACTIVE')
), draft_rows AS (
 SELECT t.id,NULL::text AS operation_id,NULL::text AS programming_id,t.draft_of_id,
   t.version,t.envelope_minutes,t.earliest_start,t.forecast_start,t.forecast_end,t.locked,t.blockers,t.configuration_key,
   o.id,o.commande_id,o.numero,pt.code_piece,o.piece_technique_version_id::text,'Opérations à définir'::text,0::int,
   'machines'::text,cc.order_type='INTERNE',cc.internal_order_purpose,o.quantite_lancee,0::numeric,0::numeric,0::numeric,0::numeric,
   NULL::text,NULL::timestamptz,NULL::timestamptz,NULL::timestamptz,NULL::timestamptz,'TODO'::text,
   o.technical_readiness,CASE WHEN cc.order_type='INTERNE' THEN COALESCE(cl.delai_interne,cl.delai_client)::text ELSE cl.delai_client::text END,1::int,o.created_at,o.updated_at,0::numeric,NULL::numeric,'DRAFT'::text
 FROM public.planning_tasks t JOIN public.ordres_fabrication o ON o.id=t.draft_of_id
 JOIN public.pieces_techniques pt ON pt.id=o.piece_technique_id
 LEFT JOIN public.commande_client cc ON cc.id=o.commande_id
 LEFT JOIN public.commande_ligne cl ON cl.id=o.commande_ligne_id
 WHERE o.statut='BROUILLON' AND NOT EXISTS(SELECT 1 FROM public.of_operations op WHERE op.of_id=o.id)
   AND NOT EXISTS(SELECT 1 FROM public.production_consolidation_allocations a WHERE a.source_of_id=o.id AND a.state='ACTIVE')
), legacy_program_rows AS (
 SELECT t.id,NULL::text AS operation_id,pr.id::text AS programming_id,NULL::bigint AS draft_of_id,
   t.version,t.envelope_minutes,t.earliest_start,t.forecast_start,t.forecast_end,t.locked,t.blockers,t.configuration_key,
   op.of_id,o.commande_id,o.numero,pt.code_piece,o.piece_technique_version_id::text,'Préparer le programme'::text,0::int,
   'programming'::text,cc.order_type='INTERNE',cc.internal_order_purpose,1::numeric,0::numeric,0::numeric,0::numeric,0::numeric,
   'person:'||pr.programmer_user_id::text,
   pr.date_commencement::timestamp AT TIME ZONE COALESCE(cal.timezone,'Europe/Paris'),
   (pr.date_fin+1)::timestamp AT TIME ZONE COALESCE(cal.timezone,'Europe/Paris'),
   NULL::timestamptz,NULL::timestamptz,'TODO'::text,'VALIDATED'::text,pr.date_fin::text,1::int,
   pr.created_at,pr.updated_at,0::numeric,t.envelope_minutes,'PROGRAMMING'::text
 FROM public.planning_tasks t JOIN public.programmations pr ON pr.id=t.programming_id
 JOIN public.pieces_techniques pt ON pt.id=pr.piece_technique_id
 LEFT JOIN public.of_operations op ON op.id=pr.of_operation_id
 LEFT JOIN public.ordres_fabrication o ON o.id=op.of_id
 LEFT JOIN public.commande_client cc ON cc.id=o.commande_id
 LEFT JOIN public.programmation_calendars cal ON cal.id=pr.calendar_id
 WHERE pr.archived_at IS NULL
), version_program_rows AS (
 SELECT t.id,NULL::text AS operation_id,pr.id::text AS programming_id,NULL::bigint AS draft_of_id,
   t.version,t.envelope_minutes,t.earliest_start,t.forecast_start,t.forecast_end,t.locked,t.blockers,t.configuration_key,
   NULL::bigint,NULL::bigint,NULL::text,pt.code_piece,v.id::text,
   'Préparer le programme — indice '||v.indice||' · révision interne '||COALESCE(v.version_interne::text,'non renseignée'),0::int,
   'programming'::text,false,NULL::text,1::numeric,CASE WHEN pr.status='DONE' THEN 1 ELSE 0 END::numeric,
   0::numeric,0::numeric,0::numeric,'person:'||pr.assignee_id::text,t.committed_start,t.committed_end,
   NULL::timestamptz,pr.completed_at,pr.status,'VALIDATED'::text,NULL::text,1::int,
   pr.updated_at,pr.updated_at,0::numeric,pr.estimated_hours*60,'PROGRAMMING'::text
 FROM public.planning_tasks t JOIN public.piece_version_programming_tasks pr ON pr.id=t.version_programming_id
 JOIN public.piece_technique_versions v ON v.id=pr.piece_technique_version_id
 JOIN public.pieces_techniques pt ON pt.id=v.piece_technique_id
 WHERE v.statut<>'OBSOLETE' OR t.locked OR t.committed_start IS NOT NULL OR pr.status<>'TODO'
   OR EXISTS(SELECT 1 FROM public.ordres_fabrication consumer
     WHERE consumer.piece_technique_version_id=v.id AND consumer.statut::text NOT IN ('ANNULE','TERMINE'))
), tasks AS (SELECT * FROM operation_rows UNION ALL SELECT * FROM draft_rows UNION ALL
 SELECT * FROM legacy_program_rows UNION ALL SELECT * FROM version_program_rows)
SELECT *,count(*) OVER()::int AS total FROM tasks
 WHERE ($3::bigint IS NULL OR of_id=$3)
 AND ($4::text IS NULL OR reference ILIKE '%'||$4||'%' OR of_number ILIKE '%'||$4||'%' OR label ILIKE '%'||$4||'%')
 AND ($5::text IS NULL OR resource_id=$5)
 AND (id=ANY($8::text[]) OR COALESCE(forecast_start,committed_start) IS NULL OR
      (committed_start<$2::timestamptz AND committed_end>$1::timestamptz) OR
      (forecast_start<$2::timestamptz AND forecast_end>$1::timestamptz))
 AND ($6::text IS NULL OR id>$6)
 ORDER BY id LIMIT $7::int
`;

export function taskFromRow(row: Row, observations: DurationObservation[] = []): CentralTask {
  const { total: _total, ...versionFields } = row;
  const resourceIds = row.resource_id ? [String(row.resource_id)] : [];
  const contextKey = [row.reference,row.revision,row.phase,row.resource_id,row.configuration_key].join("|");
  const quantity = num(row.quantity), good = num(row.good), scrap = num(row.scrap), rework = num(row.rework);
  let estimate = row.unit_minutes == null ? null : estimateDuration({
    contextKey,routingSetupMinutes:num(row.setup_minutes),routingUnitMinutes:num(row.unit_minutes),
    quantity,good,scrap,rework,observations });
  if (row.source === "DRAFT" && row.envelope_minutes != null) estimate = estimateDuration({
    contextKey,routingSetupMinutes:0,routingUnitMinutes:num(row.envelope_minutes),quantity:1,good:0,scrap:0,rework:0,observations:[] });
  const committed = interval(row.committed_start,row.committed_end);
  return { id:String(row.id),source:row.source as CentralTask["source"],operationId:str(row.operation_id),
    programmingId:str(row.programming_id),ofId:row.of_id == null ? null : num(row.of_id),orderId:row.order_id == null ? null : num(row.order_id),
    ofNumber:str(row.of_number),reference:String(row.reference),revision:str(row.revision),label:String(row.label),
    view:row.view as CentralTask["view"],internal:row.internal===true,internalPurpose:str(row.internal_purpose),quantity,good,scrap,rework,
    released:num(row.released),resourceIds,eligibleResourceIds:resourceIds,
    committed,forecast:interval(row.forecast_start,row.forecast_end),actual:row.actual_start || row.actual_end ?
      { ...(row.actual_start ? {start:instant(row.actual_start)!}:{}), ...(row.actual_end ? {end:instant(row.actual_end)!}:{}) } : null,
    commitment:row.status==="DONE" ? "DONE" : row.status==="RUNNING" ? "STARTED" : committed ? "COMMITTED" : "FORECAST",
    locked:row.locked===true,readiness:row.readiness==="VALIDATED" ? "READY" : row.source==="DRAFT" ? "DRAFT" : "MISSING",
    blockers:strings(row.blockers),earliestStart:instant(row.earliest_start),due:instant(row.due),
    priority:num(row.priority),createdAt:instant(row.created_at)!,
    version:createHash("sha256").update(JSON.stringify(versionFields)).digest("hex"),estimate };
}

export async function readCentralResources(tx: CentralQuery, from: string, to: string): Promise<Resource[]> {
  const {rows} = await tx.query<Row>(`
    WITH resources AS (
      SELECT 'machine:'||id::text AS id,'MACHINE'::text AS kind,name AS label,'machine:'||id::text AS capacity_id FROM public.machines WHERE archived_at IS NULL
      UNION ALL SELECT 'poste:'||id::text,'POSTE',code||' · '||label,COALESCE('machine:'||machine_id::text,'poste:'||id::text) FROM public.postes WHERE is_active
      UNION ALL SELECT 'person:'||u.id::text,'PERSON',COALESCE(rc.display_label,u.username),'person:'||u.id::text
        FROM public.users u LEFT JOIN public.planning_resource_calendars rc ON rc.user_id=u.id
        WHERE rc.user_id IS NOT NULL OR EXISTS(SELECT 1 FROM public.programmations p WHERE p.programmer_user_id=u.id AND p.archived_at IS NULL)
          OR EXISTS(SELECT 1 FROM public.piece_version_programming_tasks p WHERE p.assignee_id=u.id)
    )
    SELECT r.*,c.timezone,c.working_days,c.day_start::text,c.day_end::text,COALESCE(rc.version,mc.version)::text||':'||c.updated_at::text AS version,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('start',start_ts,'end',end_ts))
        FROM public.planning_resource_absences a JOIN resources ar ON ar.id=a.resource_id
        WHERE ar.capacity_id=r.capacity_id AND start_ts<$2::timestamptz AND end_ts>$1::timestamptz),'[]') ||
      COALESCE((SELECT jsonb_agg(jsonb_build_object('start',e.start_ts,'end',e.end_ts))
        FROM public.planning_events e LEFT JOIN public.postes ep ON ep.id=e.poste_id
        WHERE COALESCE('machine:'||COALESCE(e.machine_id,ep.machine_id)::text,'poste:'||e.poste_id::text)=r.capacity_id
          AND e.archived_at IS NULL AND e.status<>'CANCELLED'
          AND (e.of_operation_id IS NULL OR e.kind<>'OF_OPERATION')
          AND e.start_ts<$2::timestamptz AND e.end_ts>$1::timestamptz),'[]') AS absences,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('start',start_date::text,'end',end_date::text))
        FROM public.programmation_calendar_closures cl WHERE cl.calendar_id=c.id),'[]') AS closures
    FROM resources r LEFT JOIN public.planning_resource_calendars rc ON rc.resource_id=r.id
    LEFT JOIN public.planning_resource_calendars mc ON mc.resource_id=r.capacity_id AND r.capacity_id<>r.id
    LEFT JOIN public.programmation_calendars c ON c.id=COALESCE(rc.calendar_id,mc.calendar_id,
      (SELECT id FROM public.programmation_calendars WHERE active AND (SELECT count(*) FROM public.programmation_calendars WHERE active)=1)) AND c.active
    ORDER BY r.kind,r.label,r.id`,[from,to]);
  const cache = new Map<string, Resource["availability"]>();
  return rows.map(row => {
    const hours = (s: unknown) => { const parts = String(s).split(":").map(Number); return parts[0]*60+parts[1]; };
    const closures = Array.isArray(row.closures) ? row.closures as Array<{start:string;end:string}> : [];
    const closedDates: string[] = [];
    for (const closure of closures) for (let t=Date.parse(closure.start);t<=Date.parse(closure.end);t+=86400000)
      closedDates.push(new Date(t).toISOString().slice(0,10));
    const calendar: CalendarDefinition = {
      timezone:str(row.timezone) ?? "Europe/Paris",
      shifts:Array.isArray(row.working_days) ? row.working_days.map(day => ({
        weekday:Number(day)%7,startMinute:hours(row.day_start),endMinute:hours(row.day_end) })) : [],
      closures:Array.isArray(row.absences) ? row.absences as CalendarDefinition["closures"] : [],closedDates };
    const key = JSON.stringify(calendar);
    if (!cache.has(key)) cache.set(key,calendar.shifts.length ? expandCalendar(calendar,from,to) : []);
    return {id:String(row.id),kind:row.kind as Resource["kind"],label:String(row.label),timezone:calendar.timezone,
      capacityId:String(row.capacity_id),availability:cache.get(key)!,version:String(row.version ?? "unconfigured")};
  });
}

export async function readCentralDependencies(tx: CentralQuery): Promise<Dependency[]> {
  const {rows} = await tx.query<Row>(`
    WITH route AS (
      SELECT 'op:'||id::text AS successor_id,'op:'||lag(id) OVER(PARTITION BY of_id ORDER BY phase,id)::text AS predecessor_id
      FROM public.of_operations WHERE status::text<>'CANCELLED'
    )
    SELECT predecessor_id,successor_id,transfer_quantity,lag_minutes,
      COALESCE((SELECT sum(b.released_quantity) FROM public.production_transfer_batches b
        WHERE 'op:'||b.operation_id::text=d.predecessor_id AND 'op:'||b.successor_operation_id::text=d.successor_id),0) AS released_quantity
    FROM public.planning_operation_dependencies d
    UNION ALL
    SELECT predecessor_id,successor_id,NULL::numeric,0::numeric,0::numeric FROM route r
    WHERE predecessor_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.planning_operation_dependencies d
      WHERE d.successor_id=r.successor_id AND d.predecessor_id LIKE 'op:%')
    UNION ALL
    SELECT 'program:'||pr.id::text,'op:'||pr.of_operation_id::text,NULL::numeric,0::numeric,0::numeric
    FROM public.programmations pr WHERE pr.of_operation_id IS NOT NULL AND pr.archived_at IS NULL
    UNION ALL
    SELECT DISTINCT 'version-program:'||pr.id::text,'op:'||op.id::text,NULL::numeric,0::numeric,0::numeric
    FROM public.piece_version_programming_tasks pr
    JOIN public.ordres_fabrication o ON o.piece_technique_version_id=pr.piece_technique_version_id
    JOIN public.of_operations op ON op.of_id=o.id
    WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(o.technical_snapshot->'operations','[]')) value
      WHERE value->>'phase'=op.phase::text AND value->>'type_operation' IN ('FRAISAGE','TOURNAGE','REPRISE'))`);
  return rows.map(r => ({ predecessorId:String(r.predecessor_id),successorId:String(r.successor_id),
    transferQuantity:r.transfer_quantity == null ? null : num(r.transfer_quantity),
    releasedQuantity:num(r.released_quantity),lagMinutes:num(r.lag_minutes) }));
}

export async function readCentralSnapshot(query: CentralWindow & { includeTaskIds?: string[] }, tx?: CentralQuery): Promise<CentralSnapshot> {
  if (!tx) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const out = await readCentralSnapshot(query,client);
      await client.query("COMMIT");return out;
    } catch(e) {await client.query("ROLLBACK");throw e;} finally {client.release();}
  }
  const settings = await readCentralSettings(tx);
  const { rows } = await tx.query<Row>(TASK_QUERY,[query.from,query.to,query.of_id ?? null,query.search ?? null,
    query.resource_id ?? null,query.cursor ?? null,query.limit+1,query.includeTaskIds ?? []]);
  const more = rows.length > query.limit;
  const visible = more ? rows.slice(0,query.limit) : rows;
  const tasks = visible.map(row => taskFromRow(row));
  const operationIds = tasks.flatMap(task => task.operationId ? [task.operationId] : []);
  if (operationIds.length) {
    const { rows: qualifications } = await tx.query<{id:string;family:string|null;operation_type:string|null;eligible:string[]}>(`
      WITH qualified_resources AS (
        SELECT 'machine:'||m.id::text AS id,upper(btrim(m.machine_family_code)) AS family
        FROM public.machines m WHERE m.archived_at IS NULL AND m.status::text='ACTIVE' AND m.is_available IS NOT FALSE
          AND COALESCE((to_jsonb(m)->>'scheduling_enabled')::boolean,true)
        UNION ALL
        SELECT 'poste:'||p.id::text,upper(btrim(m.machine_family_code))
        FROM public.postes p JOIN public.machines m ON m.id=p.machine_id
        WHERE p.is_active AND m.archived_at IS NULL AND m.status::text='ACTIVE' AND m.is_available IS NOT FALSE
          AND COALESCE((to_jsonb(m)->>'scheduling_enabled')::boolean,true)
      )
      SELECT op.id::text,NULLIF(btrim(op.machine_family_code),'') AS family,frozen.operation_type,
        CASE WHEN NULLIF(btrim(op.machine_family_code),'') IS NULL
          AND frozen.operation_type IN ('DECOUPE','CONTROLE','LAVAGE','EMBALLAGE','AUTRE')
          AND p.id IS NOT NULL AND p.is_active AND p.archived_at IS NULL AND p.machine_id IS NULL AND op.machine_id IS NULL
          THEN ARRAY['poste:'||p.id::text]
          ELSE COALESCE(array_agg(r.id ORDER BY r.id) FILTER(WHERE r.id IS NOT NULL),'{}'::text[]) END AS eligible
      FROM public.of_operations op
      JOIN public.ordres_fabrication o ON o.id=op.of_id
      LEFT JOIN public.postes p ON p.id=op.poste_id
      LEFT JOIN LATERAL (SELECT value->>'type_operation' AS operation_type
        FROM jsonb_array_elements(COALESCE(o.technical_snapshot->'operations','[]'::jsonb))
        WHERE value->>'phase'=op.phase::text LIMIT 1) frozen ON true
      LEFT JOIN qualified_resources r
        ON r.family=upper(NULLIF(btrim(op.machine_family_code),''))
      WHERE op.id=ANY($1::uuid[]) GROUP BY op.id,p.id,frozen.operation_type`,[operationIds]);
    const byId = new Map(qualifications.map(row => [row.id,row]));
    for (const task of tasks) if (task.operationId) {
      const qualification = byId.get(task.operationId);
      task.eligibleResourceIds = qualification?.eligible ?? [];
      if (!qualification?.family) {
        const manual = ["DECOUPE", "CONTROLE", "LAVAGE", "EMBALLAGE", "AUTRE"].includes(qualification?.operation_type ?? "");
        if (!manual) task.blockers.push("Famille machine à définir dans la gamme.");
        else if (!task.eligibleResourceIds.length) task.blockers.push("Poste de travail à affecter dans la fiche OF.");
      }
      task.version = createHash("sha256").update(task.version+JSON.stringify(task.eligibleResourceIds)).digest("hex");
    }
  }
  const resources = await readCentralResources(tx,query.from,query.to);
  const dependencies = await readCentralDependencies(tx);
  // Future allocation writes ship in a separate milestone; their unfinished projection is not published.
  const coverage = {sources:[],demands:[],allocations:[],coverageAvailable:false};
  return {apiVersion:2,revision:settings.revision,generatedAt:new Date().toISOString(),stale:false,activation:settings.activation,
    tasks,resources,dependencies,...coverage,forecastState:await readForecastState(tx),total:num(rows[0]?.total),
    nextCursor:more ? String(visible[visible.length-1].id) : null};
}
