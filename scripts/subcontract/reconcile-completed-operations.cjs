/* Administrative repair from canonical evidence only. Dry-run rolls back all
 * writes, including audit; callers must keep a verified backup before --apply. */
const path=require('node:path');
const args=process.argv.slice(2),apply=args.includes('--apply'),database=args.find(a=>a.startsWith('--database='))?.slice(11);
const actor=Number(args.find(a=>a.startsWith('--actor-user-id='))?.slice(16));
if(!Number.isSafeInteger(actor)||actor<=0)throw Error('Explicit existing --actor-user-id=<id> required for the repair audit');
if(!database || !/^cerp_(test|prod)$/.test(database))throw Error('Explicit --database=cerp_test or cerp_prod required');
if(database==='cerp_prod'&&apply&&!args.includes('--allow-prod'))throw Error('Explicit --allow-prod required');
const pool=require(path.resolve(__dirname,'../../dist/config/database.js')).default;
const {syncClosedSubcontractOperationTx}=require(path.resolve(__dirname,'../../dist/module/subcontract/subcontract-operation-completion.repository.js'));
async function main(){
  const actual=(await pool.query('SELECT current_database() AS name')).rows[0].name;
  if(actual!==database)throw Error('Database scope mismatch');
  if(!(await pool.query('SELECT 1 FROM public.users WHERE id=$1',[actor])).rowCount)throw Error('Repair audit actor does not exist');
  const tx=await pool.connect();
  try{
    await tx.query('BEGIN');await tx.query('SELECT revision FROM public.planning_central_settings WHERE singleton FOR UPDATE');
    const operations=(await tx.query(`SELECT DISTINCT p.of_operation_id::text AS id
      FROM public.subcontract_work_packages p WHERE p.status='CLOSED'
        AND NOT EXISTS(SELECT 1 FROM public.subcontract_operation_completions c WHERE c.operation_id=p.of_operation_id)
      ORDER BY id`)).rows;
    const completed=[];
    for(const op of operations)if(await syncClosedSubcontractOperationTx(tx,op.id,actor))completed.push(op.id);
    await tx.query(apply?'COMMIT':'ROLLBACK');
    console.log(JSON.stringify({database,mode:apply?'APPLIED':'DRY_RUN_ROLLED_BACK',considered:operations.length,completed}));
  }catch(e){await tx.query('ROLLBACK');throw e;}finally{tx.release();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;}).finally(()=>pool.end());
