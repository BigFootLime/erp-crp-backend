import type {PoolClient} from 'pg';
import {HttpError} from '../../../utils/httpError';
import type {AuditContext} from '../../production/repository/production.repository';
import type {CentralSnapshot,ScheduleChange} from '../types/planning-central.types';
import {assertOperationResourceCompatible,assertResourceSchedulable,syncPlanningCoordinates} from './planning.repository';

/** Narrow extension of canonical operation scheduling: a running operation can
 * keep its machine and original start while its reviewed finish is extended. */
export async function applyRecoveryCommitmentsTx(tx:PoolClient,producerId:number,snapshot:CentralSnapshot,changes:ScheduleChange[],audit:AuditContext) {
  const selected=snapshot.tasks.filter(t=>t.ofId===producerId&&t.source==='OPERATION');
  const selectedIds=new Set(selected.map(t=>t.id));
  if(changes.some(c=>!selectedIds.has(c.taskId))||new Set(changes.map(c=>c.taskId)).size!==changes.length)
    throw new HttpError(409,'RECOVERY_PLANNING_SCOPE','La proposition modifierait un autre OF. Actualisez le contrôle.');
  await tx.query('SET CONSTRAINTS planning_events_machine_no_overlap,planning_events_poste_no_overlap DEFERRED');
  const final=[];
  for(const task of selected) {
    const change=changes.find(c=>c.taskId===task.id);
    const interval=change?.after??task.committed,resources=change?.resourceIds??task.resourceIds;
    if(!task.operationId||task.locked||task.commitment==='DONE'||task.actual?.end||!interval)
      throw new HttpError(409,'RECOVERY_OPERATION_CHANGED','Une opération ne peut plus recevoir cet ajout.');
    if(task.external) {
      if(!resources.length||resources.some(id=>!id.startsWith('supplier:')))
        throw new HttpError(409,'RECOVERY_SUPPLIER_CHANGED','Le complément doit conserver des fournisseurs identifiés.');
      const record=(await tx.query<{start:string|null;end:string|null}>(`SELECT committed_start::text AS start,committed_end::text AS end
        FROM public.planning_tasks WHERE id=$1 AND operation_id=$2::uuid FOR UPDATE`,[task.id,task.operationId])).rows[0];
      const legacy=await tx.query(`SELECT id FROM public.planning_events WHERE of_operation_id=$1::uuid
        AND archived_at IS NULL AND status<>'CANCELLED' FOR UPDATE`,[task.operationId]);
      if(!record||legacy.rows.length)throw new HttpError(409,'RECOVERY_EXTERNAL_PLAN_CHANGED',
        'Rapprochez le planning de cette prestation avant de confirmer le complément.');
      if((task.commitment==='STARTED'||task.actual?.start)&&record.start&&Date.parse(record.start)!==Date.parse(interval.start))
        throw new HttpError(409,'RECOVERY_RUNNING_OPERATION_MOVED','La prestation commencée conserve son début engagé.');
      if(change) {
        await tx.query(`UPDATE public.planning_tasks SET committed_start=$2,committed_end=$3,version=version+1,updated_at=clock_timestamp() WHERE id=$1`,
          [task.id,interval.start,interval.end]);
        await tx.query('UPDATE public.planning_central_settings SET revision=revision+1,updated_at=clock_timestamp() WHERE singleton');
        await tx.query(`INSERT INTO public.planning_recalculation_jobs(entity_table,entity_id,source_revision)
          SELECT 'planning_tasks',$1,revision FROM public.planning_central_settings WHERE singleton`,[task.id]);
      }else if(!record.start||!record.end||Date.parse(record.start)!==Date.parse(interval.start)||Date.parse(record.end)!==Date.parse(interval.end))
        throw new HttpError(409,'RECOVERY_EXTERNAL_PLAN_CHANGED','Le créneau fournisseur a changé. Actualisez la proposition.');
      final.push({operation_id:task.operationId,start:interval.start,end:interval.end,resource_id:resources[0]});
      continue;
    }
    if(resources.length!==1)throw new HttpError(422,'PLANNING_RESOURCE_INVALID','Sélectionnez une seule machine ou un poste.');
    const resourceId=resources[0],resource={machine_id:resourceId.startsWith('machine:')?resourceId.slice(8):null,poste_id:resourceId.startsWith('poste:')?resourceId.slice(6):null};
    if(!resource.machine_id&&!resource.poste_id)throw new HttpError(422,'PLANNING_RESOURCE_INVALID','Sélectionnez une machine ou un poste compatible.');
    await assertResourceSchedulable(tx,resource);
    await assertOperationResourceCompatible({tx,of_operation_id:task.operationId,resource});
    const events=(await tx.query<{id:string;start:string;end:string;machine_id:string|null;poste_id:string|null}>(`SELECT id::text,start_ts::text AS start,end_ts::text AS end,machine_id::text,poste_id::text
      FROM public.planning_events WHERE of_operation_id=$1::uuid AND archived_at IS NULL AND status<>'CANCELLED' ORDER BY id FOR UPDATE`,[task.operationId])).rows;
    if(events.length>1)throw new HttpError(409,'PLANNING_SPLIT_OPERATION','Cette opération possède plusieurs créneaux à rapprocher.');
    const running=task.commitment==='STARTED'||!!task.actual?.start,event=events[0];
    if(running&&(!event||Date.parse(interval.start)!==Date.parse(event.start)
      ||resource.machine_id!==event.machine_id||resource.poste_id!==event.poste_id))
      throw new HttpError(409,'RECOVERY_RUNNING_OPERATION_MOVED','Une opération en cours conserve son début et sa machine.');
    if(change) {
      if(event)await tx.query(`UPDATE public.planning_events SET start_ts=$2,end_ts=$3,machine_id=$4,poste_id=$5,
        updated_by=$6,updated_at=clock_timestamp() WHERE id=$1::uuid`,[event.id,interval.start,interval.end,resource.machine_id,resource.poste_id,audit.user_id]);
      else await tx.query(`INSERT INTO public.planning_events(id,kind,status,priority,of_id,of_operation_id,title,start_ts,end_ts,machine_id,poste_id,created_by,updated_by)
        VALUES(gen_random_uuid(),'OF_OPERATION','PLANNED','NORMAL',$1,$2::uuid,$3,$4,$5,$6,$7,$8,$8)`,
      [producerId,task.operationId,task.label,interval.start,interval.end,resource.machine_id,resource.poste_id,audit.user_id]);
      await syncPlanningCoordinates({tx,of_operation_id:task.operationId,of_id:producerId});
    }else if(!event)throw new HttpError(409,'RECOVERY_OPERATION_UNPLANNED','Un créneau a disparu. Actualisez la proposition.');
    final.push({operation_id:task.operationId,start:interval.start,end:interval.end,resource_id:resourceId});
  }
  await tx.query('SET CONSTRAINTS planning_events_machine_no_overlap,planning_events_poste_no_overlap IMMEDIATE');
  return final;
}
