const assert=require('node:assert/strict'),path=require('node:path');
const compiled=process.env.SUBCONTRACT1273_COMPILED_ROOT;
assert(compiled,'Explicit compiled fixture required');
const pool=require(path.join(compiled,'config/database.js')).default;
const {syncClosedSubcontractOperationTx}=require(path.join(compiled,'module/subcontract/subcontract-operation-completion.repository.js'));
const {readOperationReadinessTx}=require(path.join(compiled,'module/production/repository/operation-readiness.repository.js'));
const express=require('express');
let server,checks=0;
const operation='67e46502-6b6d-4cbf-8191-220508947e44',nextOperation='0c9f1748-d7fb-4ccd-bf69-76bf4e2a1f64';
async function check(name,fn){await fn();checks++;console.log('PASS '+name);}
async function inRollback(fn){const tx=await pool.connect();try{await tx.query('BEGIN');await tx.query('SELECT revision FROM public.planning_central_settings WHERE singleton FOR UPDATE');await fn(tx);}finally{await tx.query('ROLLBACK');tx.release();}}
async function main(){
  assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name,'subcontract_completion_1273');
  const packages=(await pool.query(`SELECT p.id,p.qty_planned::float8 AS quantity,p.row_version
    FROM public.subcontract_work_packages p WHERE p.of_operation_id=$1 ORDER BY p.qty_planned DESC`,[operation])).rows;
  assert.deepEqual(packages.map(p=>p.quantity),[18,2]);
  assert.equal((await pool.query('SELECT status::text FROM public.of_operations WHERE id=$1',[operation])).rows[0].status,'TODO');
  const baseline=(await pool.query(`SELECT
    (SELECT count(*)::int FROM public.production_quantity_declarations) AS declarations,
    (SELECT count(*)::int FROM public.production_pointages) AS pointages,
    (SELECT count(*)::int FROM public.stock_movements) AS stock,
    (SELECT count(*)::int FROM public.ordres_fabrication) AS ofs`)).rows[0];
  const app=express();app.use(express.json());app.use((req,_res,next)=>{req.user={id:1,role:req.header('x-fixture-role')||'Production Achat'};next();});
  app.use('/packages',require(path.join(compiled,'module/subcontract/subcontract.routes.js')).default);
  app.use((e,_req,res,_next)=>res.status(e.statusCode||e.status||500).json({code:e.code,message:e.message}));
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  async function post(route,body,key){const r=await fetch(base+route,{method:'POST',headers:{'content-type':'application/json',...(key?{'Idempotency-Key':key}:{})},body:JSON.stringify(body)});return{status:r.status,body:await r.json()};}
  await check('open supplier dossiers do not finish the operation',async()=>inRollback(async tx=>{
    assert.equal(await syncClosedSubcontractOperationTx(tx,operation,1),false);
  }));
  await check('actual return18 transfers without fabricating local quantities',async()=>{
    const r=await fetch(base+'/packages/'+packages[0].id+'/flow');assert.equal(r.status,200);const data=await r.json();
    const flow=data.flow;assert(flow,JSON.stringify(data));assert.equal(flow.returns.length,1);
    const saved=await post('/packages/'+packages[0].id+'/transfers',{return_id:flow.returns[0].id,successor_operation_id:nextOperation,quantity:18,expected_version:flow.version,reason:'Isolated fixture1273',action:'RELEASE'},'fixture1273-transfer18');
    assert.equal(saved.status,200,JSON.stringify(saved));
  });
  await check('closing first18 preserves partial availability and open phase',async()=>{
    const version=(await pool.query('SELECT row_version FROM public.subcontract_work_packages WHERE id=$1',[packages[0].id])).rows[0].row_version;
    const r=await post('/packages/'+packages[0].id+'/close',{expected_row_version:version,reason:'Isolated closure18'});assert.equal(r.status,200,JSON.stringify(r));
    assert.equal((await pool.query('SELECT status::text FROM public.of_operations WHERE id=$1',[operation])).rows[0].status,'TODO');
    await inRollback(async tx=>{const ready=await readOperationReadinessTx(tx,95);assert.equal(ready.operations.find(op=>op.id===nextOperation).availableQuantity,18);});
  });
  await check('remaining2 transfer with their own origin',async()=>{
    const data=await(await fetch(base+'/packages/'+packages[1].id+'/flow')).json();const flow=data.flow;
    const r=await post('/packages/'+packages[1].id+'/transfers',{return_id:flow.returns[0].id,successor_operation_id:nextOperation,quantity:2,expected_version:flow.version,reason:'Isolated fixture1273',action:'RELEASE'},'fixture1273-transfer2');
    assert.equal(r.status,200,JSON.stringify(r));
  });
  async function temporarilyCloseLast(tx){
    await tx.query("UPDATE public.subcontract_work_packages SET status='CLOSED',row_version=row_version+1,closed_at=now(),closed_by=1,close_reason='Isolated evidence rehearsal' WHERE id=$1",[packages[1].id]);
  }
  await check('reconciliation refuses newer Quality hold before completion',async()=>inRollback(async tx=>{
    await temporarilyCloseLast(tx);
    await tx.query(`UPDATE public.quality_control SET qty_released=0,qty_held=qty_population
      WHERE reception_ligne_id IN(SELECT receipt_line_id FROM public.reception_subcontract_origins WHERE package_id=$1)`,[packages[1].id]);
    assert.equal(await syncClosedSubcontractOperationTx(tx,operation,1),false);
    assert.equal((await tx.query('SELECT count(*)::int n FROM public.subcontract_operation_completions WHERE operation_id=$1',[operation])).rows[0].n,0);
  }));
  await check('legacy local output is preserved for review, never added to external output',async()=>inRollback(async tx=>{
    await temporarilyCloseLast(tx);
    await tx.query('INSERT INTO public.production_quantity_declarations(of_id,operation_id,qty_good,declared_by) VALUES(95,$1,1,1)',[operation]);
    assert.equal(await syncClosedSubcontractOperationTx(tx,operation,1),false);
    assert.equal((await tx.query('SELECT good::float8 AS qty FROM public.production_operation_quantities WHERE operation_id=$1',[operation])).rows[0].qty,1);
  }));
  await check('blocked operation cannot be completed by reconciliation',async()=>inRollback(async tx=>{
    await temporarilyCloseLast(tx);await tx.query("UPDATE public.of_operations SET status='BLOCKED' WHERE id=$1",[operation]);
    assert.equal(await syncClosedSubcontractOperationTx(tx,operation,1),false);
    assert.equal((await tx.query('SELECT status::text FROM public.of_operations WHERE id=$1',[operation])).rows[0].status,'BLOCKED');
  }));
  await check('successful dry-run rolls back state, proof and audit',async()=>inRollback(async tx=>{
    await temporarilyCloseLast(tx);assert.equal(await syncClosedSubcontractOperationTx(tx,operation,1),true);
    assert.equal((await tx.query('SELECT good::float8 AS qty FROM public.production_operation_quantities WHERE operation_id=$1',[operation])).rows[0].qty,20);
  }));
  assert.equal((await pool.query('SELECT count(*)::int n FROM public.subcontract_operation_completions WHERE operation_id=$1',[operation])).rows[0].n,0);
  assert.equal((await pool.query("SELECT count(*)::int n FROM public.erp_audit_logs WHERE action='SUBCONTRACT_OPERATION_COMPLETED' AND entity_id=$1",[operation])).rows[0].n,0);
  await check('last normal dossier closure records canonical DONE and20 good',async()=>{
    const version=(await pool.query('SELECT row_version FROM public.subcontract_work_packages WHERE id=$1',[packages[1].id])).rows[0].row_version;
    const r=await post('/packages/'+packages[1].id+'/close',{expected_row_version:version,reason:'Isolated closure2'});assert.equal(r.status,200,JSON.stringify(r));
    const op=(await pool.query('SELECT status::text,started_at,ended_at FROM public.of_operations WHERE id=$1',[operation])).rows[0];
    assert.equal(op.status,'DONE');assert(op.started_at);assert(op.ended_at);
    const q=(await pool.query('SELECT good::float8,scrap::float8,pending::float8,rework::float8 FROM public.production_operation_quantities WHERE operation_id=$1',[operation])).rows[0];
    assert.deepEqual(q,{good:20,scrap:0,pending:0,rework:0});
  });
  await check('source proof preserves two returns and authoritative dates',async()=>{
    const p=(await pool.query('SELECT evidence,ended_at FROM public.subcontract_operation_completions WHERE operation_id=$1',[operation])).rows[0];
    assert.equal(p.evidence.packageIds.length,2);assert.deepEqual(p.evidence.returns.map(r=>r.quantity),[18,2]);
    const end=(await pool.query('SELECT max(closed_at) AS at FROM public.subcontract_work_packages WHERE of_operation_id=$1',[operation])).rows[0].at;
    assert.equal(p.ended_at.toISOString(),end.toISOString());
  });
  await check('reconciliation retry is a no-op with one evidence and audit',async()=>inRollback(async tx=>{
    assert.equal(await syncClosedSubcontractOperationTx(tx,operation,1),false);
    assert.equal((await tx.query('SELECT count(*)::int n FROM public.subcontract_operation_completions WHERE operation_id=$1',[operation])).rows[0].n,1);
    const audit=(await tx.query("SELECT count(*)::int n,min(user_id)::int actor FROM public.erp_audit_logs WHERE action='SUBCONTRACT_OPERATION_COMPLETED' AND entity_id=$1",[operation])).rows[0];
    assert.deepEqual(audit,{n:1,actor:1});
  }));
  await check('completed operation remaining0 and next phase available20',async()=>inRollback(async tx=>{
    const ready=await readOperationReadinessTx(tx,95),source=ready.operations.find(op=>op.id===operation),next=ready.operations.find(op=>op.id===nextOperation);
    assert.equal(source.status,'DONE');assert.equal(source.processedQuantity,20);assert.equal(source.remainingQuantity,0);assert.equal(source.canStart,false);
    assert.equal(next.availableQuantity,20);
  }));
  await check('later Quality hold still reduces downstream availability',async()=>inRollback(async tx=>{
    await tx.query(`UPDATE public.quality_control SET qty_released=0,qty_held=qty_population
      WHERE reception_ligne_id IN(SELECT receipt_line_id FROM public.reception_subcontract_origins WHERE package_id=$1)`,[packages[0].id]);
    const ready=await readOperationReadinessTx(tx,95);assert.equal(ready.operations.find(op=>op.id===nextOperation).availableQuantity,2);
    assert.equal((await tx.query('SELECT qty_good::float8 AS qty FROM public.subcontract_operation_completions WHERE operation_id=$1',[operation])).rows[0].qty,20);
  }));
  await check('completion evidence cannot be edited or deleted',async()=>{
    await assert.rejects(pool.query('UPDATE public.subcontract_operation_completions SET qty_good=19 WHERE operation_id=$1',[operation]),e=>e.code==='55000');
    await assert.rejects(pool.query('DELETE FROM public.subcontract_operation_completions WHERE operation_id=$1',[operation]),e=>e.code==='55000');
  });
  await check('local output cannot duplicate external completion',async()=>{
    await assert.rejects(pool.query('INSERT INTO public.production_quantity_declarations(of_id,operation_id,qty_good,declared_by) VALUES(95,$1,20,1)',[operation]),e=>e.code==='23514'&&e.message==='SUBCONTRACT_OUTPUT_ALREADY_RECORDED');
  });
  await check('no new local declaration, pointing, stock or recovery OF',async()=>{
    const after=(await pool.query(`SELECT (SELECT count(*)::int FROM public.production_quantity_declarations) AS declarations,
      (SELECT count(*)::int FROM public.production_pointages) AS pointages,
      (SELECT count(*)::int FROM public.stock_movements) AS stock,
      (SELECT count(*)::int FROM public.ordres_fabrication) AS ofs`)).rows[0];assert.deepEqual(after,baseline);
  });
  console.log('SUBCONTRACT1273_POSTGRES_PASS: '+checks);
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(server)await new Promise(r=>server.close(r));await pool.end();});
