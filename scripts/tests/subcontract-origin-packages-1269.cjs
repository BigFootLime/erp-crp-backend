const assert=require('node:assert/strict'),path=require('node:path');
const compiled=process.env.SUBCONTRACT1269_COMPILED_ROOT;
assert(compiled,'Explicit compiled fixture required');
const pool=require(path.join(compiled,'config/database.js')).default;
const express=require('express');
let server,checks=0;
async function check(name,fn){await fn();checks++;console.log('PASS '+name);}
async function main(){
  const identity=(await pool.query("SELECT current_database() db")).rows[0];
  assert.equal(identity.db,'subcontract_origin_1269');
  const order='8dd33def-925b-4bcd-9730-c4993371744e';
  const rows=(await pool.query(`SELECT l.id,l.quantite::float8 quantity,l.unite,origin.operation_id,origin.material_origin_id
    FROM public.commande_fournisseur_ligne l JOIN public.subcontract_purchase_origins origin ON origin.line_id=l.id
    WHERE l.commande_id=$1 ORDER BY l.quantite DESC`,[order])).rows;
  assert.deepEqual(rows.map(x=>x.quantity),[18,2]);
  assert.equal(rows[0].operation_id,rows[1].operation_id);
  assert.equal((await pool.query('SELECT count(*)::int n FROM public.subcontract_work_packages WHERE of_operation_id=$1',[rows[0].operation_id])).rows[0].n,0);
  const evidence=(await pool.query("SELECT id FROM public.ged_documents WHERE code='DT-000016' AND archived_at IS NULL")).rows[0]?.id;
  assert(evidence);
  // Seed the restored fixture only. Real recipe transitions are performed in UI.
  await pool.query("UPDATE public.commande_fournisseur SET statut='ENVOYEE' WHERE id=$1",[order]);
  const app=express();app.use(express.json());
  app.use((req,_res,next)=>{req.user={id:1,role:req.header('x-fixture-role')||'Production Achat'};next();});
  app.use('/packages',require(path.join(compiled,'module/subcontract/subcontract.routes.js')).default);
  app.use((e,_req,res,_next)=>res.status(e.statusCode||e.status||500).json({code:e.code,message:e.message}));
  server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const base='http://127.0.0.1:'+server.address().port;
  async function post(route,body,key,role){
    const r=await fetch(base+route,{method:'POST',headers:{'content-type':'application/json',...(key?{'Idempotency-Key':key}:{}),...(role?{'x-fixture-role':role}:{})},body:JSON.stringify(body)});
    return {status:r.status,body:await r.json()};
  }
  const bodies=rows.map(l=>({supplier_order_line_id:l.id,of_operation_id:l.operation_id,ged_evidence_document_id:evidence,unit:'U',qty_planned:l.quantity}));
  let first,second;
  await check('first origin18 creates canonical dossier',async()=>{first=await post('/packages',bodies[0]);assert.equal(first.status,201,JSON.stringify(first));});
  await check('second origin2 shares treatment operation without500',async()=>{second=await post('/packages',bodies[1]);assert.equal(second.status,201,JSON.stringify(second));assert.notEqual(second.body.id,first.body.id);});
  await check('concurrent identical retries retain same immutable dossier',async()=>{
    const responses=await Promise.all([post('/packages',bodies[1]),post('/packages',bodies[1])]);
    for(const r of responses){assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.body.id,second.body.id);}
    assert.equal((await pool.query('SELECT count(*)::int n FROM public.subcontract_work_packages WHERE of_operation_id=$1',[rows[0].operation_id])).rows[0].n,2);
  });
  await check('changed quantity on existing line gives409 and does not replace dossier',async()=>{const r=await post('/packages',{...bodies[1],qty_planned:1});assert.equal(r.status,409);assert.equal(r.body.code,'SUBCONTRACT_PACKAGE_ALREADY_EXISTS');});
  await check('supplier line uniqueness remains a database invariant',async()=>{
    const r=await pool.query("SELECT count(*)::int n FROM pg_constraint WHERE conrelid='public.subcontract_work_packages'::regclass AND contype='u' AND pg_get_constraintdef(oid)='UNIQUE (supplier_order_line_id)'");assert.equal(r.rows[0].n,1);
  });
  await check('wrong material origin rejected before custody',async()=>{const r=await post('/packages/'+first.body.id+'/issues',{lot_id:rows[1].material_origin_id,unit:'U',qty:18},'fixture1269-wrong-origin');assert.equal(r.status,409);assert.equal(r.body.code,'SUBCONTRACT_WRONG_MATERIAL_ORIGIN');});
  await check('unit mismatch does not imply material conversion',async()=>{const r=await post('/packages/'+first.body.id+'/issues',{lot_id:rows[0].material_origin_id,unit:'MM',qty:18},'fixture1269-wrong-unit');assert.equal(r.status,409);assert.equal(r.body.code,'SUBCONTRACT_UNIT_MISMATCH');});
  await check('first18 pieces dispatched on their actual material identity',async()=>{const r=await post('/packages/'+first.body.id+'/issues',{lot_id:rows[0].material_origin_id,unit:'U',qty:18},'fixture1269-origin18');assert.equal(r.status,201,JSON.stringify(r));});
  await check('second2 pieces dispatched after first18',async()=>{const r=await post('/packages/'+second.body.id+'/issues',{lot_id:rows[1].material_origin_id,unit:'U',qty:2},'fixture1269-origin2');assert.equal(r.status,201,JSON.stringify(r));});
  await check('cumulative dispatch cannot exceed20 available machined pieces',async()=>{const r=await post('/packages/'+second.body.id+'/issues',{lot_id:rows[1].material_origin_id,unit:'U',qty:1},'fixture1269-over-issued');assert.equal(r.status,409);assert.equal(r.body.code,'SUBCONTRACT_PREDECESSOR_QUANTITY');});
  await check('dispatch network retry does not duplicate custody',async()=>{const r=await post('/packages/'+second.body.id+'/issues',{lot_id:rows[1].material_origin_id,unit:'U',qty:2},'fixture1269-origin2');assert.equal(r.status,200);assert.equal(r.body.idempotent_replay,true);});
  await check('custody ledger remains immutable and exactly20',async()=>{
    const r=await pool.query("SELECT sum(e.qty)::float8 qty,count(*)::int n FROM public.subcontract_work_package_ledger e JOIN public.subcontract_work_packages p ON p.id=e.package_id WHERE p.of_operation_id=$1 AND e.event_type='ISSUE'",[rows[0].operation_id]);assert.equal(r.rows[0].qty,20);assert.equal(r.rows[0].n,2);
    await assert.rejects(pool.query('UPDATE public.subcontract_work_package_ledger SET qty=1 WHERE package_id=$1',[first.body.id]),e=>e.code==='55000');
  });
  await check('quality gate still rejects released raw-lot as a supplier return',async()=>{const r=await post('/packages/'+second.body.id+'/returns',{lot_id:rows[1].material_origin_id,unit:'U',qty:2},'fixture1269-not-quarantined');assert.equal(r.status,409);assert.equal(r.body.code,'SUBCONTRACT_RETURN_NOT_QUARANTINED');});
  await check('read-only board preserves both origin dossiers independently',async()=>{
    const r=await fetch(base+'/packages?of_id=95');assert.equal(r.status,200);const v=await r.json();assert.equal(v.work_packages.length,2);assert.deepEqual(v.work_packages.map(p=>Number(p.custody_open_qty)).sort((a,b)=>a-b),[2,18]);
  });
  console.log('SUBCONTRACT1269_POSTGRES_PASS: '+checks);
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(server)await new Promise(r=>server.close(r));await pool.end();});
