import pool from "../../../config/database";
import { readLearningSources, readLearningState, readDurationAccuracy } from "../repository/duration-learning.repository";
import { buildDurationObservation } from "../domain/duration-learning";
import { runDurationLearningOnce } from "../services/duration-learning.worker";

/** Explicit, bounded backfill. Dry-run unless --apply; cursor is printed only on success. */
async function main() {
  const args=process.argv.slice(2);
  if(args.includes('--help')) {
    console.log('duration-learning [--after UUID] [--limit 100] [--apply] [--run] [--status]');
    return;
  }
  const allowed=new Set(['--after','--limit','--apply','--run','--status']);
  for(let i=0;i<args.length;i++) {
    if(!allowed.has(args[i]))throw new Error('Unknown argument');
    if(args[i]==='--after'||args[i]==='--limit')i++;
  }
  const value=(flag:string)=>args.includes(flag)?args[args.indexOf(flag)+1]:undefined;
  const after=value('--after')??'00000000-0000-0000-0000-000000000000';
  const limit=Number(value('--limit')??100);
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(after)
    ||!Number.isInteger(limit)||limit<1||limit>500)throw new Error('Invalid cursor or limit (1..500)');
  if(args.includes('--status')) {console.log(JSON.stringify({state:await readLearningState(pool),accuracy:await readDurationAccuracy(pool)}));return;}
  if(args.includes('--run')&&!args.includes('--apply'))throw new Error('--run requires --apply');
  const tx=await pool.connect();
  try {
    await tx.query('BEGIN');
    await tx.query("SET LOCAL statement_timeout='30s'");
    await tx.query("SET LOCAL lock_timeout='3s'");
    if(args.includes('--apply'))await tx.query('SELECT revision FROM public.planning_central_settings WHERE singleton FOR UPDATE');
    else await tx.query('SET TRANSACTION READ ONLY');
    const ids=(await tx.query<{id:string}>(`SELECT op.id FROM public.of_operations op WHERE op.id>$1::uuid
      AND (EXISTS(SELECT 1 FROM public.production_pointages p WHERE p.operation_id=op.id)
        OR EXISTS(SELECT 1 FROM public.production_quantity_declarations d WHERE d.operation_id=op.id)
        OR EXISTS(SELECT 1 FROM public.of_time_logs l WHERE l.of_operation_id=op.id))
      ORDER BY op.id LIMIT $2`,[after,limit])).rows.map(r=>r.id);
    const observations=(await readLearningSources(tx,ids)).map(buildDurationObservation);
    const reasons:Record<string,number>={};
    for(const o of observations)reasons[o.excludedReason??'ELIGIBLE']=(reasons[o.excludedReason??'ELIGIBLE']??0)+1;
    if(args.includes('--apply'))for(const id of ids)await tx.query('SELECT public.planning_queue_learning($1::uuid)',[id]);
    await tx.query('COMMIT');
    const processed=args.includes('--run')?await runDurationLearningOnce():0;
    console.log(JSON.stringify({mode:args.includes('--apply')?'queued':'dry-run',scanned:ids.length,reasons,
      nextCursor:ids.at(-1)??after,hasMore:ids.length===limit,processed}));
  }catch(error){await tx.query('ROLLBACK');throw error;}finally{tx.release();}
}
main().catch(error=>{console.error(error instanceof Error?error.message:'Duration maintenance failed');process.exitCode=1;}).finally(()=>pool.end());
