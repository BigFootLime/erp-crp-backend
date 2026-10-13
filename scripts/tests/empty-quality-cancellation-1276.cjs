const assert=require('node:assert/strict'),path=require('node:path');
const root=process.env.QUALITY1276_COMPILED_ROOT;assert(root);
const pool=require(path.join(root,'config/database.js')).default;
const repo=require(path.join(root,'module/qualite/repository/quality-360.repository.js'));
const {cancelEmptyExecution}=require(path.join(root,'module/qualite/controllers/quality-360.controller.js'));
const {requireQualityCapability}=require(path.join(root,'module/qualite/middlewares/quality-authorization.middleware.js'));
const express=require('express');
const id='23dd3a99-2b73-4aee-8a37-a63772f826c8',lot='67e7c48d-daa4-4eb8-b8d1-e136a45ea461';
const reason='Isolated fixture: replace erroneous empty control; preserve its original plan and source.';
const actor={user_id:1,role:'Responsable qualité',ip:null,user_agent:null,device_type:null,os:null,browser:null,path:null,page_key:null,client_session_id:null,request_id:null};
let server,checks=0;
async function check(name,fn){await fn();checks++;console.log('PASS '+name);}
async function noWrites(){return(await pool.query(`SELECT
 (SELECT count(*)::int FROM public.stock_movements) AS movements,
 (SELECT count(*)::int FROM public.quality_release_decision) AS decisions,
 (SELECT count(*)::int FROM public.non_conformity) AS nonconformities,
 (SELECT count(*)::int FROM public.quality_control_points) AS points,
 (SELECT lot_status::text FROM public.lots WHERE id=$1::uuid) AS lot_status,
 (SELECT sum(qty_total)::text FROM public.stock_batches WHERE lot_id=$1::uuid) AS physical`,[lot])).rows[0];}
async function main(){
 assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name,'empty_quality_cancellation_1276');
 const before=await repo.repoGetExecution(id);assert(before);assert.equal(before.measurements.length,0);assert.equal(before.plan.version,1);
 const baseline=await noWrites();assert.equal(baseline.lot_status,'QUARANTAINE');assert.equal(Number(baseline.physical),20);
 const app=express();app.use(express.json());
 // Explicit fixture authentication. Exercise the real capability middleware,
 // controller and PostgreSQL command; this is not a production JWT test.
 app.use((req,_res,next)=>{const role=req.header('x-fixture-role');if(role)req.user={id:1,role};next();});
 app.post('/executions/:id/cancel-empty',requireQualityCapability('release_decide'),cancelEmptyExecution);
 app.use((error,_req,res,_next)=>res.status(error.status||500).json({code:error.code||'FIXTURE_ERROR',message:error.message}));
 server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const url='http://127.0.0.1:'+server.address().port;
 async function post(target,body,role='Responsable qualité'){const response=await fetch(url+'/executions/'+target+'/cancel-empty',{method:'POST',headers:{'content-type':'application/json',...(role?{'x-fixture-role':role}:{})},body:JSON.stringify(body)});return{status:response.status,body:await response.json()};}
 const body={expected_updated_at:before.updated_at,reason};
 await check('authentication required and operator capability denied',async()=>{assert.equal((await post(id,body,null)).status,401);assert.equal((await post(id,body,'Tourneur')).status,403);assert.deepEqual(await noWrites(),baseline);});
 await check('short reason and injected quantity fields refused',async()=>{assert.equal((await post(id,{...body,reason:'No'})).status,422);assert.equal((await post(id,{...body,qty:20})).status,422);});
 await check('stale revision refused',async()=>{assert.equal((await post(id,{...body,expected_updated_at:'2001-01-01T00:00:00Z'})).status,409);assert.deepEqual(await noWrites(),baseline);});
 const oldEventCount=Number((await pool.query("SELECT count(*) AS n FROM public.quality_event_log WHERE entity_id=$1 AND event_type='EXECUTION_CANCELLED'",[id])).rows[0].n);
 await check('empty control cancelled through real controller',async()=>{const response=await post(id,body);assert.equal(response.status,200,JSON.stringify(response));assert.equal(response.body.status,'CANCELLED');assert.equal(response.body.execution_cancellation_reason,reason);assert.equal(response.body.execution_cancelled_by,1);assert.equal(response.body.plan_snapshot_sha256,before.plan_snapshot_sha256);assert.deepEqual(response.body.ledger,before.ledger);assert.equal(response.body.plan.version,1);});
 await check('cancellation leaves physical stock, quality, decisions and NC untouched',async()=>assert.deepEqual(await noWrites(),baseline));
 await check('concurrent retries create one event and one cancellation',async()=>{const responses=await Promise.all([post(id,body),post(id,body)]);assert(responses.every(r=>r.status===200&&r.body.id===id));const count=Number((await pool.query("SELECT count(*) AS n FROM public.quality_event_log WHERE entity_id=$1 AND event_type='EXECUTION_CANCELLED'",[id])).rows[0].n);assert.equal(count,oldEventCount+1);});
 await check('a different cancellation reason cannot overwrite history',async()=>assert.equal((await post(id,{...body,reason:'A different fixture reason'})).status,409));
 await check('direct reopening and deletion refused by PostgreSQL',async()=>{await assert.rejects(()=>pool.query("UPDATE public.quality_control SET status='IN_PROGRESS',execution_cancelled_at=NULL,execution_cancelled_by=NULL,execution_cancellation_reason=NULL WHERE id=$1",[id]),/remains immutable/);await assert.rejects(()=>pool.query('DELETE FROM public.quality_control WHERE id=$1',[id]),/remains immutable/);});
 await check('cancelled control rejects measurements and verdict preview',async()=>{const current=await repo.repoGetExecution(id);await assert.rejects(()=>repo.repoRecordMeasurements({id,body:{expected_updated_at:new Date(current.updated_at).toISOString(),measurements:[]},actor}),e=>e.code==='QUALITY_EXECUTION_CLOSED');await assert.rejects(()=>repo.repoPreviewVerdict(id),e=>e.code==='QUALITY_EXECUTION_CANCELLED');});
 await check('direct sample and release writes on cancelled parent refused',async()=>{await assert.rejects(()=>pool.query('INSERT INTO public.quality_control_points(quality_control_id,characteristic) VALUES($1,\'Fixture\')',[id]),/accepts no measurements or decisions/);await assert.rejects(()=>pool.query('INSERT INTO public.quality_release_decision(quality_control_id) VALUES($1)',[id]),/accepts no measurements or decisions/);});
 let next;
 await check('corrected applicable plan opens a new control without erasing old one',async()=>{
  const article=(await pool.query('SELECT article_id::text FROM public.lots WHERE id=$1',[lot])).rows[0].article_id;
  const context={source_type:'LOT',source_id:lot,trigger:'RECHECK',population:20,unite:'u',article_id:article,lot_id:lot};
  const preview=await repo.repoPreviewExecution(context);
  next=await repo.repoCreateExecution({body:{...context,preview_sha256:preview.snapshot_sha256,comments:'Isolated corrected-plan fixture; no production quality decision'},actor,idempotencyKey:'fixture1276-new-control'});
  assert.notEqual(next.id,id);assert.equal(next.plan.version,2);assert.equal((await repo.repoGetExecution(id)).status,'CANCELLED');assert.equal(next.measurements.length,0);
 });
 await check('a validated final control cannot be cancelled',async()=>{const target=await repo.repoGetExecution('28ab705a-116d-45a0-9cf3-304b010e4e08');assert.equal(target.status,'VALIDATED');assert.equal((await post(target.id,{expected_updated_at:target.updated_at,reason})).status,409);});
 await check('row locking preserves a sample committed before cancellation',async()=>{
  const tx=await pool.connect();let pending;
  try {
   await tx.query('BEGIN');await tx.query('SELECT id FROM public.quality_control WHERE id=$1 FOR UPDATE',[next.id]);
   pending=post(next.id,{expected_updated_at:next.updated_at,reason});
   const spec=next.characteristics[0];
   await tx.query(`INSERT INTO public.quality_control_points(quality_control_id,characteristic,characteristic_key,sample_no,value_boolean,result,evaluation_code,criticality,recorded_by) VALUES($1,$2,$3,1,true,'OK','FIXTURE', $4,1)`,[next.id,spec.label,spec.key,spec.criticality]);
   await tx.query('COMMIT');const response=await pending;assert.equal(response.status,409);assert.equal(response.body.code,'QUALITY_CANCELLATION_HAS_MEASUREMENTS');assert.equal((await repo.repoGetExecution(next.id)).status,'IN_PROGRESS');
  } finally {await tx.query('ROLLBACK');tx.release();if(pending)await pending;}
 });
 await check('ordinary quality release continues after cancellation and assigns existing stock',async()=>{
  const current=await repo.repoGetExecution(next.id),spec=current.characteristics[0];
  await repo.repoRecordMeasurements({id:next.id,actor,idempotencyKey:'fixture1276-complete-corrected-control',
   body:{expected_updated_at:new Date(current.updated_at).toISOString(),measurements:Array.from({length:19},(_,index)=>({
    characteristic_key:spec.key,sample_no:index+2,value_boolean:true,value_numeric:null,value_text:null,
    unit:null,instrument_id:null,comment:'Isolated fictional check; final control CQ1309 already conforming.'}))}});
  const controlled=await repo.repoGetExecution(next.id),preview=await repo.repoPreviewVerdict(next.id);
  assert.equal(preview.verdict,'CONFORME');assert.equal(controlled.ledger.controlled,20);
  const released=await repo.repoDecideExecution({id:next.id,actor,idempotencyKey:'fixture1276-release-corrected-control',body:{
   expected_updated_at:new Date(controlled.updated_at).toISOString(),preview_sha256:preview.preview_sha256,
   decision:'FULL',object_type:'LOT',object_id:lot,qty:20,unite:'u',justification:'Isolated Base Test fixture: correctly identified20 axes, final CQ1309 conforming, packaging checked; no industrial decision.'}});
  assert.equal(released.ledger.released,20);assert.equal(released.status,'VALIDATED');
  const after=await noWrites();assert.equal(after.lot_status,'LIBERE');assert.equal(after.physical,baseline.physical);
  assert.equal(after.nonconformities,baseline.nonconformities);
  assert.equal((await repo.repoGetExecution(id)).status,'CANCELLED');
  const assigned=(await pool.query('SELECT sum(quantity)::float8 AS amount FROM public.production_receipt_lane_assignments WHERE receipt_id IN(SELECT id FROM public.of_receipts WHERE lot_id=$1)',[lot])).rows[0];
  assert.equal(assigned.amount,20);
 });
 console.log(JSON.stringify({status:'PASSED',checks,database:'empty_quality_cancellation_1276',cancelledControl:id,liveDatabasesChanged:false,productionJwtTested:false}));
}
main().catch(e=>{console.error(e.stack||e.message);process.exitCode=1;}).finally(async()=>{if(server)await new Promise(r=>server.close(r));await pool.end();});
