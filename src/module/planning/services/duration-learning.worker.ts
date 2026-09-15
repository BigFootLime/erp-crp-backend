import pool from "../../../config/database";
import { withRealtimeOutboxTransaction } from "../../../shared/realtime/realtime-outbox-transaction";
import { enqueueEntityChanged } from "../../../shared/realtime/realtime-outbox.service";
import { readLearningSources, persistLearningObservation } from "../repository/duration-learning.repository";

/** Separate consumer: the forecast worker must never acknowledge learning jobs. */
export async function runDurationLearningOnce(): Promise<number> {
  let ids:string[]=[];
  try {
    return await withRealtimeOutboxTransaction(await pool.connect(),async tx=>{
      const installed=await tx.query("SELECT to_regclass('public.planning_learning_jobs') AS installed");
      if(!installed.rows[0]?.installed)return 0;
      if(!(await tx.query("SELECT pg_try_advisory_xact_lock(hashtextextended('planning:duration-learning',0)) AS acquired")).rows[0]?.acquired)return 0;
      await tx.query("SET LOCAL statement_timeout='20s'");
      await tx.query("SET LOCAL lock_timeout='3s'");
      await tx.query('SELECT revision FROM public.planning_central_settings WHERE singleton FOR UPDATE');
      ids=(await tx.query<{operation_id:string}>(`SELECT operation_id FROM public.planning_learning_jobs
        ORDER BY requested_at,operation_id LIMIT 100 FOR UPDATE`)).rows.map(r=>r.operation_id);
      if(!ids.length)return 0;
      const sources=await readLearningSources(tx,ids);
      for(const source of sources)await persistLearningObservation(tx,source);
      await tx.query('DELETE FROM public.planning_learning_jobs WHERE operation_id=ANY($1::uuid[])',[ids]);
      const {rows}=await tx.query<{revision:string}>(`UPDATE public.planning_central_settings SET revision=revision+1,
        updated_at=clock_timestamp() WHERE singleton RETURNING revision::text`);
      await tx.query(`INSERT INTO public.planning_recalculation_jobs(entity_table,entity_id,source_revision)
        VALUES('planning_estimation_observations','batch',$1::bigint)`,[rows[0].revision]);
      await tx.query(`UPDATE public.planning_learning_state SET calculated_at=now(),last_error=NULL,
        processed_operations=processed_operations+$1 WHERE singleton`,[sources.length]);
      await enqueueEntityChanged(tx,{entityType:'PLANNING_EVENTS',entityId:'duration-learning',module:'planning',
        action:'updated',at:new Date().toISOString(),invalidateKeys:['planning:events','production:ofs']},
        {deduplicationKey:`duration-learning:${rows[0].revision}`});
      return sources.length;
    });
  } catch(error) {
    if(ids.length){
      await pool.query(`UPDATE public.planning_learning_jobs SET attempts=attempts+1,last_error='LEARNING_RECALCULATION_FAILED'
        WHERE operation_id=ANY($1::uuid[])`,[ids]);
      await pool.query("UPDATE public.planning_learning_state SET last_error='LEARNING_RECALCULATION_FAILED' WHERE singleton");
    }
    throw error;
  }
}
export function startDurationLearningMaintenance(){
  let running:Promise<unknown>|null=null,stopped=false;
  const cycle=()=>{if(stopped||running)return;running=runDurationLearningOnce()
    .catch(()=>console.error(JSON.stringify({type:'duration_learning_failed'}))).finally(()=>{running=null;});};
  const timer=setInterval(cycle,15000);timer.unref?.();cycle();
  return async()=>{stopped=true;clearInterval(timer);await running;};
}
