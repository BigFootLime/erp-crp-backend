import type { PoolClient } from "pg";
import { buildDurationObservation, durationContextKey, type LearningSource } from "../domain/duration-learning";
import { estimateDuration, type DurationObservation } from "../domain/central-estimation";
import type { CentralSnapshot, CentralTask, Resource } from "../types/planning-central.types";

type Query = Pick<PoolClient, "query">;
export async function readLearningSources(tx: Query, operationIds: string[]): Promise<LearningSource[]> {
  if (!operationIds.length) return [];
  const {rows} = await tx.query<{source:LearningSource}>(`
    SELECT jsonb_build_object('operationId',op.id,'status',op.status,
      'cancelled',o.statut::text='ANNULE' OR op.status::text='CANCELLED'
        OR EXISTS(SELECT 1 FROM public.of_revisions r WHERE r.id=op.revision_id AND r.statut<>'ACTIVE'),
      'completedAt',op.ended_at,
      'context',COALESCE(public.planning_duration_context(op.id,op.machine_id,op.poste_id),
        CASE WHEN o.piece_technique_version_id IS NOT NULL AND o.technical_snapshot_sha256 IS NOT NULL THEN
          jsonb_build_object('pieceId',o.piece_technique_id::text,'revision',o.piece_technique_version_id::text,
            'phase',op.phase,'machineId','','configuration',COALESCE(t.configuration_key,'')) END),
      'legacyUnmapped',EXISTS(SELECT 1 FROM public.of_time_logs l WHERE l.of_operation_id=op.id AND l.pointage_id IS NULL),
      'segments',COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id',p.id,'start',p.start_ts,'end',p.end_ts,'status',p.status,'validated',p.validated_at IS NOT NULL,
        'rejected',p.rejected_at IS NOT NULL,'updatedAt',p.updated_at,'correctsId',p.corrects_pointage_id,
        'replaced',EXISTS(SELECT 1 FROM public.production_pointages successor WHERE successor.corrects_pointage_id=p.id),
        'context',CASE WHEN p.context_snapshot ? 'duration_learning' THEN p.context_snapshot->'duration_learning'->'context'
          WHEN p.machine_id IS NOT NULL AND COALESCE(t.configuration_key,'')=''
          THEN public.planning_duration_context(op.id,p.machine_id,NULL) ELSE NULL END,
        'bucket',COALESCE(p.context_snapshot->'duration_learning'->>'bucket',
          CASE WHEN p.activity_code IN ('SETUP','PRODUCTION') THEN p.activity_code
            WHEN p.activity_code IN ('PROGRAMMING','CONTROL','MAINTENANCE','CLEANING','TOOL_CHANGE',
              'WAIT_MATERIAL','WAIT_PROGRAM','WAIT_QUALITY','PLANNED_STOP','UNPLANNED_STOP','OTHER') THEN 'EXCLUDED'
            ELSE 'UNKNOWN' END))) FROM public.production_pointages p WHERE p.operation_id=op.id),'[]'),
      'quantities',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',d.id,'pointageId',d.pointage_id,
        'good',d.qty_good,'scrap',d.qty_scrap,'rework',d.qty_rework,'pending',d.qty_pending_control,'declaredAt',d.declared_at))
        FROM public.production_quantity_declarations d WHERE d.operation_id=op.id),'[]')) AS source
    FROM public.of_operations op JOIN public.ordres_fabrication o ON o.id=op.of_id
    LEFT JOIN public.planning_tasks t ON t.operation_id=op.id
    WHERE op.id=ANY($1::uuid[]) ORDER BY op.id`,[operationIds]);
  return rows.map(r=>r.source);
}

export async function persistLearningObservation(tx: Query, source: LearningSource) {
  const observation=buildDurationObservation(source);
  // Old contexts are retained as excluded evidence, never left in another machine's sample.
  await tx.query(`UPDATE public.planning_estimation_observations SET excluded_reason='CONTEXT_REPLACED',validated_at=NULL
    WHERE operation_id=$1 AND measurement_kind='MACHINE' AND context_key<>$2
      AND excluded_reason IS DISTINCT FROM 'CONTEXT_REPLACED'`,[source.operationId,observation.contextKey]);
  await tx.query(`INSERT INTO public.planning_estimation_observations(operation_id,context_key,measurement_kind,
    productive_minutes,attributable_quantity,setup_minutes,validated_at,excluded_reason,source_revision,recorded_at,
    context_snapshot,pointage_ids,declaration_ids,calculated_at)
    VALUES($1,$2,'MACHINE',$3,$4,$5,CASE WHEN $6 THEN now() ELSE NULL END,$7,$8,$9,$10::jsonb,$11::uuid[],$12::uuid[],now())
    ON CONFLICT(operation_id,measurement_kind,context_key) DO UPDATE SET
      productive_minutes=EXCLUDED.productive_minutes,attributable_quantity=EXCLUDED.attributable_quantity,
      setup_minutes=EXCLUDED.setup_minutes,validated_at=EXCLUDED.validated_at,excluded_reason=EXCLUDED.excluded_reason,
      source_revision=EXCLUDED.source_revision,recorded_at=EXCLUDED.recorded_at,context_snapshot=EXCLUDED.context_snapshot,
      pointage_ids=EXCLUDED.pointage_ids,declaration_ids=EXCLUDED.declaration_ids,calculated_at=now()
    WHERE planning_estimation_observations.source_revision IS DISTINCT FROM EXCLUDED.source_revision
      OR planning_estimation_observations.excluded_reason IS DISTINCT FROM EXCLUDED.excluded_reason`,
    [source.operationId,observation.contextKey,observation.productiveMinutes,Math.max(0,observation.quantity),observation.setupMinutes,
      observation.validated,observation.excludedReason,observation.sourceRevision,observation.recordedAt,JSON.stringify(observation.context),
      observation.pointageIds,observation.declarationIds]);
  return observation;
}

type ObservationRow = {id:string;operation_id:string;context_key:string;productive_minutes:number;attributable_quantity:number;
  setup_minutes:number|null;validated_at:string|null;excluded_reason:string|null;recorded_at:string;source_revision:string;calculated_at:string};
const observationFromRow = (r:ObservationRow):DurationObservation => ({id:r.id,contextKey:r.context_key,
  productiveMinutes:Number(r.productive_minutes),quantity:Number(r.attributable_quantity),setupMinutes:r.setup_minutes===null?null:Number(r.setup_minutes),
  validated:!!r.validated_at,excludedReason:r.excluded_reason,recordedAt:new Date(r.recorded_at).toISOString()});

/** One grouped query for all tasks/resources. LIMIT applies after eligibility and self-exclusion. */
export async function hydrateDurationEstimates(tx:Query,tasks:CentralTask[],resources:Resource[],enabled:boolean) {
  if(!enabled)return;
  const operations=tasks.filter(t=>t.operationId&&t.estimate);
  if(!operations.length)return;
  const sources=await readLearningSources(tx,operations.map(t=>t.operationId!));
  const sourceById=new Map(sources.map(s=>[s.operationId,s]));
  const resourceById=new Map(resources.map(r=>[r.id,r]));
  const targets:Array<{task_id:string;operation_id:string;context_key:string;resource_id:string}> = [];
  for(const task of operations){
    const context=sourceById.get(task.operationId!)?.context;
    if(!context)continue;
    for(const id of new Set([...task.resourceIds,...task.eligibleResourceIds])){
      const physical=resourceById.get(id)?.capacityId ?? id;
      if(!physical.startsWith('machine:'))continue;
      targets.push({task_id:task.id,operation_id:task.operationId!,resource_id:id,
        context_key:durationContextKey({...context,machineId:physical.slice(8)})});
    }
  }
  const {rows}=targets.length ? await tx.query<ObservationRow & {task_id:string;resource_id:string}>(`
    SELECT target.task_id,target.resource_id,observation.* FROM jsonb_to_recordset($1::jsonb)
      AS target(task_id text,operation_id uuid,context_key text,resource_id text)
    CROSS JOIN LATERAL(SELECT o.* FROM public.planning_estimation_observations o
      WHERE o.context_key=target.context_key AND o.operation_id<>target.operation_id AND o.measurement_kind='MACHINE'
        AND o.validated_at IS NOT NULL AND o.excluded_reason IS NULL AND o.productive_minutes>0 AND o.attributable_quantity>0
        AND NOT EXISTS(SELECT 1 FROM public.planning_learning_jobs j WHERE j.operation_id=o.operation_id)
      ORDER BY o.recorded_at DESC,o.id LIMIT 20) observation`,[JSON.stringify(targets)]) : {rows:[]};
  const grouped=new Map<string,typeof rows>();
  for(const row of rows){const key=row.task_id+'|'+row.resource_id;grouped.set(key,[...(grouped.get(key)??[]),row]);}
  for(const task of operations){
    const source=sourceById.get(task.operationId!),current=source?buildDurationObservation(source):null;
    const original=task.estimate!;
    const routingSetup=original.routingSetupMinutes??original.setupMinutes,routingUnit=original.routingUnitMinutes??original.unitMinutes;
    task.resourceEstimates={};
    for(const target of targets.filter(t=>t.task_id===task.id)){
      const records=grouped.get(task.id+'|'+target.resource_id)??[];
      const sameCurrent=current?.contextKey===target.context_key;
      const estimate=estimateDuration({contextKey:target.context_key,routingSetupMinutes:routingSetup,routingUnitMinutes:routingUnit,
        quantity:task.quantity,good:task.good,scrap:task.scrap,rework:task.rework,observations:records.map(observationFromRow),
        ...(sameCurrent ? {current:current.current??undefined,setupCompletedMinutes:current.setupCompletedMinutes}: {})});
      estimate.learnedAt=records.map(r=>new Date(r.calculated_at).toISOString()).sort().at(-1)??null;
      task.resourceEstimates[target.resource_id]=estimate;
    }
    task.estimate=task.resourceEstimates[task.resourceIds[0]]??original;
  }
}

export async function readLearningState(tx:Query) {
  const {rows}=await tx.query(`SELECT s.calculated_at,s.last_error,s.processed_operations::text,
    (SELECT count(*)::int FROM public.planning_learning_jobs) AS pending,
    (SELECT min(requested_at) FROM public.planning_learning_jobs) AS oldest_pending_at
    FROM public.planning_learning_state s WHERE singleton`);
  return rows[0]??{calculated_at:null,last_error:null,pending:0,oldest_pending_at:null,processed_operations:'0'};
}

export async function recordDurationPredictions(tx:Query,snapshot:CentralSnapshot) {
  if(snapshot.activation!=='LEARN')return;
  const tasks=snapshot.tasks.filter(t=>t.operationId&&t.estimate&&t.commitment!=='DONE'&&t.commitment!=='STARTED');
  const sources=new Map((await readLearningSources(tx,tasks.map(t=>t.operationId!))).map(s=>[s.operationId,s]));
  const resources=new Map(snapshot.resources.map(r=>[r.id,r]));
  for(const task of tasks) {
    const source=sources.get(task.operationId!),estimate=task.estimate!;
    const physical=resources.get(task.resourceIds[0])?.capacityId??task.resourceIds[0];
    if(!source?.context||!physical?.startsWith('machine:'))continue;
    const contextKey=durationContextKey({...source.context,machineId:physical.slice(8)});
    await tx.query(`INSERT INTO public.planning_duration_predictions(operation_id,context_key,unit_minutes,setup_minutes,
      routing_unit_minutes,policy,observations,source_revision)
      SELECT $1,$2,$3,$4,$5,$6,$7,$8 WHERE
        NOT EXISTS(SELECT 1 FROM public.production_pointages WHERE operation_id=$1)
        AND NOT EXISTS(SELECT 1 FROM public.production_quantity_declarations WHERE operation_id=$1)
        AND NOT EXISTS(SELECT 1 FROM public.of_time_logs WHERE of_operation_id=$1)
        AND EXISTS(SELECT 1 FROM public.of_operations WHERE id=$1 AND started_at IS NULL)
      ON CONFLICT(operation_id) DO NOTHING`,[task.operationId,contextKey,estimate.unitMinutes,estimate.setupMinutes,
      estimate.routingUnitMinutes??estimate.unitMinutes,estimate.policy,estimate.observations,snapshot.revision]);
  }
}

export async function readDurationAccuracy(tx:Query) {
  const {rows}=await tx.query(`SELECT count(*)::int AS evaluated_operations,
    percentile_cont(0.5) WITHIN GROUP(ORDER BY abs(p.unit_minutes-o.productive_minutes/o.attributable_quantity)) AS median_unit_error_minutes,
    percentile_cont(0.5) WITHIN GROUP(ORDER BY abs(p.routing_unit_minutes-o.productive_minutes/o.attributable_quantity)) AS routing_median_unit_error_minutes
    FROM public.planning_duration_predictions p JOIN public.planning_estimation_observations o
      ON o.operation_id=p.operation_id AND o.context_key=p.context_key AND o.measurement_kind='MACHINE'
    WHERE o.validated_at IS NOT NULL AND o.excluded_reason IS NULL AND o.attributable_quantity>0
      AND NOT EXISTS(SELECT 1 FROM public.planning_learning_jobs j WHERE j.operation_id=o.operation_id)
      AND NOT EXISTS(SELECT 1 FROM public.production_pointages s WHERE s.operation_id=o.operation_id AND s.start_ts<p.predicted_at)`);
  return rows[0];
}

export async function readTaskObservations(tx:Query,operationId:string,offset:number,limit:number) {
  const sources=await readLearningSources(tx,[operationId]);
  if(!sources[0])return null;
  const context=sources[0].context;
  const {rows}=await tx.query<ObservationRow & {pointage_ids:string[];declaration_ids:string[];of_number:string;total:number;used:boolean;enabled:boolean}>(`
    WITH retained AS (SELECT o.id FROM public.planning_estimation_observations o
      WHERE o.context_key=$1 AND o.operation_id<>$2::uuid AND o.measurement_kind='MACHINE'
      AND o.validated_at IS NOT NULL AND o.excluded_reason IS NULL AND o.productive_minutes>0 AND o.attributable_quantity>0
      AND NOT EXISTS(SELECT 1 FROM public.planning_learning_jobs j WHERE j.operation_id=o.operation_id)
      ORDER BY o.recorded_at DESC,o.id LIMIT 20)
    SELECT o.*,work.numero AS of_number,count(*) OVER()::int AS total,
      settings.activation='LEARN' AS enabled,
      settings.activation='LEARN' AND EXISTS(SELECT 1 FROM retained r WHERE r.id=o.id) AS used
    FROM public.planning_estimation_observations o
    CROSS JOIN public.planning_central_settings settings
    JOIN public.of_operations op ON op.id=o.operation_id JOIN public.ordres_fabrication work ON work.id=op.of_id
    WHERE o.measurement_kind='MACHINE' AND (o.context_key=$1 OR o.operation_id=$2::uuid)
    ORDER BY o.recorded_at DESC,o.id LIMIT $3 OFFSET $4`,[context?durationContextKey(context):'',operationId,limit,offset]);
  return {items:rows.map(r=>({...observationFromRow(r),operationId:r.operation_id,ofNumber:r.of_number,
    pointageIds:r.pointage_ids,declarationIds:r.declaration_ids,sourceRevision:r.source_revision,
    calculatedAt:new Date(r.calculated_at).toISOString(),self:r.operation_id===operationId,used:r.used,
    unusedReason:!r.enabled?'LEARNING_DISABLED':r.operation_id===operationId?'SELF':r.excluded_reason??(!r.used?'HISTORY_WINDOW':null)})),total:rows[0]?.total??0,
    offset,limit,current:buildDurationObservation(sources[0]).excludedReason};
}
