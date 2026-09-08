import pool from '../../../config/database';
import {withRealtimeOutboxTransaction} from '../../../shared/realtime/realtime-outbox-transaction';
import {enqueueEntityChanged} from '../../../shared/realtime/realtime-outbox.service';
import {readCentralSnapshot,readCentralDependencies} from '../repository/planning-central.repository';
import {materialWorkflowEnabled} from '../../production/repository/of-dossier.repository';
import {readMaterialTx} from '../../production/repository/of-material.repository';
import {readOperationReadinessTx} from '../../production/repository/operation-readiness.repository';
import {materialForecastAvailability} from '../domain/material-forecast';
import {schedule} from '../domain/central-scheduler';
import {HttpError} from '../../../utils/httpError';

/** Durable queue, single DB writer, bounded calculation. Only forecast columns
 * are written: no planning_event, assignment, commitment or actual date. */
export async function runPlanningForecastOnce(){
  let maxJob:string|null=null;
  try{return await withRealtimeOutboxTransaction(await pool.connect(),async tx=>{
    if(!await materialWorkflowEnabled(tx))return false;
    if(!(await tx.query("SELECT pg_try_advisory_xact_lock(hashtextextended('planning:forecast-worker',0)) AS acquired")).rows[0]?.acquired)return false;
    await tx.query("SET LOCAL statement_timeout='45s'");
    await tx.query("SET LOCAL lock_timeout='3s'");
    const settings=(await tx.query<{revision:string}>('SELECT revision::text FROM public.planning_central_settings WHERE singleton FOR UPDATE')).rows[0];
    const queued=(await tx.query<{id:string|null}>('SELECT max(id)::text AS id FROM public.planning_recalculation_jobs WHERE processed_at IS NULL')).rows[0];
    maxJob=queued?.id??null;
    const state=(await tx.query<{refresh:boolean}>(`SELECT calculated_at IS NULL OR calculated_at<now()-interval '30 minutes' AS refresh FROM public.planning_forecast_state WHERE singleton`)).rows[0];
    if(!maxJob&&!state?.refresh)return false;
    const ids=(await tx.query<{id:string}>(`SELECT t.id FROM public.planning_tasks t JOIN public.of_operations p ON p.id=t.operation_id
      JOIN public.ordres_fabrication o ON o.id=p.of_id WHERE o.statut::text NOT IN ('TERMINE','CLOTURE','ANNULE')
      AND(p.revision_id IS NULL OR EXISTS(SELECT 1 FROM public.of_revisions r WHERE r.id=p.revision_id AND r.statut='ACTIVE'))
      ORDER BY t.id LIMIT 2001`)).rows.map(r=>r.id);
    if(ids.length>2000)throw new HttpError(503,'FORECAST_WINDOW_TOO_DENSE','Calcul trop volumineux.');
    const now=new Date().toISOString(),to=new Date(Date.parse(now)+180*86400000).toISOString();
    const dependencies=await readCentralDependencies(tx),included=new Set(ids);
    let grew=true;
    while(grew){grew=false;for(const edge of dependencies)if(included.has(edge.successorId)&&!included.has(edge.predecessorId)){included.add(edge.predecessorId);grew=true;}}
    if(included.size>10000)throw new HttpError(503,'FORECAST_WINDOW_TOO_DENSE','Calcul trop volumineux.');
    const snapshot=await readCentralSnapshot({from:now,to,limit:10000,includeTaskIds:[...included]},tx);
    if(snapshot.nextCursor)throw new HttpError(503,'FORECAST_WINDOW_TOO_DENSE','Calcul trop volumineux.');
    const activeIds=new Set(ids),ofIds=[...new Set(snapshot.tasks.filter(t=>activeIds.has(t.id)).flatMap(t=>t.ofId?[t.ofId]:[]))];
    const tasks=snapshot.tasks.map(t=>({...t,blockers:[...t.blockers]}));
    for(const ofId of ofIds){
      const coverage=await readMaterialTx(tx,ofId),readiness=await readOperationReadinessTx(tx,ofId,coverage);
      for(const task of tasks.filter(t=>t.ofId===ofId&&activeIds.has(t.id)&&t.commitment!=='DONE')){
        const op=readiness.operations.find(o=>o.id===task.operationId);
        if(!op){task.blockers.push('Disponibilité opération inconnue.');task.earliestStart=null;continue;}
        // Routing and programming dates are resolved by the existing dependency graph.
        const timedCodes=['PREDECESSOR_REQUIRED','FULL_MATERIAL_REQUIRED','QUANTITY_UNAVAILABLE','OPERATION_NOT_PLANNED'];
        if(snapshot.dependencies.some(d=>d.successorId===task.id&&d.predecessorId.includes('program:')))timedCodes.push('PROGRAM_REQUIRED');
        const blocking=op.blockers.filter(b=>!timedCodes.includes(b.code)&&b.code!=='QUANTITY_COMPLETE');
        task.blockers.push(...blocking.map(b=>b.message));
        let earliest=now;
        for(const need of coverage.needs.filter(n=>n.operationId===task.operationId)){
          const supply=materialForecastAvailability({now,required:need.required,consumed:need.consumed,reserved:need.reserved,blocked:need.receivedBlocked,preparation:need.blockers,
            promises:[...need.promises.map(p=>({quantity:Math.max(0,p.assigned-p.received),date:p.due})),
              ...coverage.customerCalls.filter(c=>c.need_id===need.id&&c.status==='ANNOUNCED').map(c=>({quantity:Math.max(0,c.quantity-c.received),date:c.announced_date}))]});
          if(supply.reason)task.blockers.push(supply.reason);
          if(supply.date&&supply.date>earliest)earliest=supply.date;
        }
        task.earliestStart=task.blockers.length?null:earliest;
        // Remaining duration of an operation already started is projected from
        // now on its assigned resource; its real start and committed slot stay intact.
        if(task.commitment==='STARTED'){task.commitment='COMMITTED';task.locked=false;}
      }
    }
    const requested=tasks.filter(t=>t.commitment!=='DONE'&&!t.locked&&(activeIds.has(t.id)||t.source==='PROGRAMMING')).map(t=>({taskId:t.id,earliestStart:now}));
    const result=schedule({tasks,resources:snapshot.resources,dependencies:snapshot.dependencies,from:now,requested});
    for(const task of snapshot.tasks){
      const issues=result.conflicts.filter(c=>c.taskId===task.id).map(c=>c.message),projection=result.forecasts[task.id];
      await tx.query(`UPDATE public.planning_tasks SET forecast_start=$2::timestamptz,forecast_end=$3::timestamptz,forecast_issues=$4::jsonb
        WHERE id=$1 AND(forecast_start,forecast_end,forecast_issues) IS DISTINCT FROM($2::timestamptz,$3::timestamptz,$4::jsonb)`,
        [task.id,issues.length?null:projection?.start??null,issues.length?null:projection?.end??null,JSON.stringify(issues)]);
    }
    if(maxJob)await tx.query('UPDATE public.planning_recalculation_jobs SET processed_at=now(),attempts=attempts+1,last_error=NULL WHERE id<=$1::bigint AND processed_at IS NULL',[maxJob]);
    await tx.query('UPDATE public.planning_forecast_state SET calculated_at=now(),source_revision=$1::bigint,issue_count=$2,last_error=NULL WHERE singleton',[settings.revision,result.conflicts.length]);
    await enqueueEntityChanged(tx,{entityType:'PLANNING_EVENTS',entityId:'forecast',module:'planning',action:'updated',at:now,invalidateKeys:['planning:events','production:ofs']},{deduplicationKey:`planning-forecast:${settings.revision}:${now}`});
    return true;
  });}catch(error){
    const code=error instanceof HttpError?error.code:'FORECAST_RECALCULATION_FAILED';
    // A failed or interrupted transaction leaves every job pending. Error text
    // is deliberately bounded and contains no SQL or source data.
    await pool.query('UPDATE public.planning_forecast_state SET last_error=$1 WHERE singleton',[code]);
    if(maxJob)await pool.query('UPDATE public.planning_recalculation_jobs SET attempts=attempts+1,last_error=$2 WHERE id<=$1::bigint AND processed_at IS NULL',[maxJob,code]);
    throw error;
  }
}
export function startPlanningForecastMaintenance(){
  let running:Promise<unknown>|null=null,stopped=false;
  const cycle=()=>{if(stopped||running)return;running=runPlanningForecastOnce().catch(()=>console.error(JSON.stringify({type:'planning_forecast_failed'}))).finally(()=>{running=null;});};
  const timer=setInterval(cycle,30000);timer.unref?.();cycle();
  return async()=>{stopped=true;clearInterval(timer);await running;};
}
