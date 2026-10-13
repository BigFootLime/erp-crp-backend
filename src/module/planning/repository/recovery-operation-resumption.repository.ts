import type {PoolClient} from 'pg';
import {HttpError} from '../../../utils/httpError';
import type {CentralSnapshot} from '../types/planning-central.types';
import type {AuditContext} from '../../production/repository/production.repository';

type SavedRow = Record<string,unknown>;
export type RecoveryOperationResumption = {
  operation_id:string; task_id:string; before:SavedRow;
  planning_events:SavedRow[]; planning_task:SavedRow|null;
};

/** Keep completed cycles in the immutable addition journal before reopening
 * their existing operation. Declarations, time logs and genealogy are untouched. */
export async function readRecoveryOperationResumptionsTx(tx:PoolClient,producerId:number,snapshot:CentralSnapshot) {
  const selected=snapshot.tasks.filter(t=>t.ofId===producerId&&t.source==='OPERATION'&&(t.commitment==='DONE'||t.actual?.end));
  const resumptions:RecoveryOperationResumption[]=[];
  for(const task of selected) {
    if(!task.operationId||task.operationType==='DECOUPE'||task.commitment!=='DONE'||!task.actual?.end)
      throw new HttpError(409,'RECOVERY_COMPLETION_CHANGED','La clôture de l’opération a changé. Actualisez la proposition.');
    const row=(await tx.query<{before:SavedRow;busy:boolean}>(`SELECT to_jsonb(op) AS before,
      EXISTS(SELECT 1 FROM public.production_pointages p WHERE p.operation_id=op.id AND p.status='RUNNING')
      OR EXISTS(SELECT 1 FROM public.of_time_logs l WHERE l.of_operation_id=op.id AND l.ended_at IS NULL) AS busy
      FROM public.of_operations op WHERE op.id=$1::uuid AND op.of_id=$2 FOR UPDATE`,[task.operationId,producerId])).rows[0];
    if(!row||row.busy||row.before.status!=='DONE'||!row.before.ended_at
      ||Date.parse(String(row.before.ended_at))!==Date.parse(task.actual.end))
      throw new HttpError(409,'RECOVERY_COMPLETION_CHANGED','Terminez les pointages et actualisez la clôture avant la reprise.');
    const events=(await tx.query<{saved:SavedRow}>(`SELECT to_jsonb(e) AS saved FROM public.planning_events e
      WHERE e.of_operation_id=$1::uuid AND e.archived_at IS NULL AND e.status<>'CANCELLED' ORDER BY e.id FOR UPDATE`,[task.operationId])).rows.map(r=>r.saved);
    const planned=(await tx.query<{saved:SavedRow}>(`SELECT to_jsonb(t) AS saved FROM public.planning_tasks t
      WHERE t.id=$1 AND t.operation_id=$2::uuid FOR UPDATE`,[task.id,task.operationId])).rows[0]?.saved??null;
    if(events.length>1||task.external&&(events.length>0||!planned))
      throw new HttpError(409,'RECOVERY_COMPLETION_CHANGED','Rapprochez les anciens créneaux avant de reprendre cette opération.');
    resumptions.push({operation_id:task.operationId,task_id:task.id,before:row.before,planning_events:events,planning_task:planned});
  }
  return resumptions;
}

/** Called only after insertion of the immutable decision. Deferred SQL guards
 * require the saved history and a fresh reviewed commitment in this transaction. */
export async function resumeRecoveryOperationsTx(tx:PoolClient,snapshot:CentralSnapshot,resumptions:RecoveryOperationResumption[],audit:AuditContext):Promise<CentralSnapshot> {
  for(const proof of resumptions) {
    const ids=proof.planning_events.map(e=>e.id);
    if(ids.length) {
      const archived=await tx.query(`UPDATE public.planning_events SET archived_at=clock_timestamp(),archived_by=$2,
        updated_at=clock_timestamp(),updated_by=$2 WHERE id=ANY($1::uuid[]) AND archived_at IS NULL`,[ids,audit.user_id]);
      if(archived.rowCount!==ids.length)throw new HttpError(409,'RECOVERY_HISTORY_CHANGED','Les anciens créneaux ont changé. Actualisez la proposition.');
    }
    const reopened=await tx.query(`UPDATE public.of_operations op SET status='READY',started_at=NULL,ended_at=NULL,updated_at=clock_timestamp()
      WHERE id=$1::uuid AND to_jsonb(op)=$2::jsonb`,[proof.operation_id,JSON.stringify(proof.before)]);
    if(reopened.rowCount!==1)throw new HttpError(409,'RECOVERY_COMPLETION_CHANGED','La clôture a changé. Actualisez la proposition.');
  }
  const ids=new Set(resumptions.map(p=>p.task_id));
  return {...snapshot,tasks:snapshot.tasks.map(task=>ids.has(task.id)
    ? {...task,commitment:'COMMITTED',actual:null,committed:task.external?task.committed:null} : task)};
}
