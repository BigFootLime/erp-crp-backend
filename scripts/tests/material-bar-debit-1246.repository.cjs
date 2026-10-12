/* Disposable minimal canonical fixture only. Connection JSON arrives on stdin. */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{randomUUID:id}=require('node:crypto'),{Client}=require('pg');
const root=process.env.MATERIAL_BAR_COMPILED_ROOT,load=file=>require(path.join(root,`src/module/stock/repository/${file}.repository.js`));
const {readMaterialBarInventoryTx,lockMaterialBarInventoryTx,writeMaterialBarInventoryTx}=load('material-bar-inventory');
const {prepareMaterialBarDebitTx,applyMaterialBarDebitTx,materialBarConsumptionExtra,materialBarDebitPostingOwner}=load('material-bar-debit');
const {prepareMaterialBarCorrectionTx,applyMaterialBarCorrectionTx,materialBarCorrectionPostingOwner}=load('material-bar-correction');
const {consumeMaterialBarPostingOwner}=require(path.join(root,'src/module/stock/repository/material-bar-posting-owner.js'));
const config=JSON.parse(fs.readFileSync(0,'utf8'));assert.equal(config.database,'material_bars_1246');
const tx=new Client(config);let passed=0;
const pass=label=>{passed++;console.log(`PASS: ${label}`);};
async function setup(lengths,allocations){
 const article=id(),lot=id(),level=id(),batch=id(),barIds=lengths.map(()=>id()),reservations=[...new Set(allocations.map(a=>a.r))].map(key=>({key,id:id()}));
 await tx.query("INSERT INTO public.articles VALUES($1,'BAR-DEBIT','Cut fixture','mm')",[article]);
 await tx.query("INSERT INTO public.lots VALUES($1,$2,'CUT-FIXTURE')",[lot,article]);
 await tx.query('INSERT INTO public.stock_levels VALUES($1,$2)',[level,article]);
 await tx.query('INSERT INTO public.stock_batches VALUES($1,$2,$3,$4,$5)',[batch,lot,level,lengths.reduce((a,b)=>a+b,0),allocations.reduce((s,a)=>s+a.q,0)]);
 for(const r of reservations)await tx.query("INSERT INTO public.stock_reservations(id,stock_batch_id,qty_reserved,qty_consumed,status) VALUES($1,$2,$3,0,'ACTIVE')",[r.id,batch,allocations.filter(a=>a.r===r.key).reduce((s,a)=>s+a.q,0)]);
 await tx.query('BEGIN');const current=await lockMaterialBarInventoryTx(tx,batch);
 await writeMaterialBarInventoryTx(tx,current,{expectedVersion:current.version,idempotencyKey:id(),reason:'Measured cutting fixture',bars:lengths.map((lengthMm,index)=>({id:barIds[index],lengthMm,
  allocations:allocations.filter(a=>a.b===index).map(a=>({reservationId:reservations.find(r=>r.key===a.r).id,quantityMm:a.q}))}))},1246,id());
 await tx.query('COMMIT');return {batch,barIds,r:key=>reservations.find(r=>r.key===key).id};
}
// Minimal canonical postings matching the production owner's transaction order.
// Real ERP stock/quality/pointage commands are covered separately, not by this fixture.
async function post(plan,batch){
 const consumed=[];
 for(const [reservationId,a] of plan.consumptions){
  assert.equal(materialBarConsumptionExtra(a,reservationId,a.quantityMm),a.extraMm);
  await tx.query('UPDATE public.stock_batches SET qty_total=qty_total-$2,qty_reserved=qty_reserved+$3-$2 WHERE id=$1',[batch,a.quantityMm,a.extraMm]);
  await tx.query("UPDATE public.stock_reservations SET qty_reserved=qty_reserved+$3,qty_consumed=qty_consumed+$2,status=CASE WHEN qty_reserved+$3=qty_consumed+$2 THEN 'CONSUMED' ELSE 'ACTIVE' END,row_version=row_version+1 WHERE id=$1",[reservationId,a.quantityMm,a.extraMm]);
  const stockMovementId=id(),owner=materialBarDebitPostingOwner(tx,a,stockMovementId);
  consumeMaterialBarPostingOwner(tx,owner,{id:stockMovementId,batchId:batch,type:'OUT',quantity:a.quantityMm,reversalOf:null});
  await tx.query("INSERT INTO public.stock_movements(id,stock_batch_id,status) VALUES($1,$2,'POSTED')",[stockMovementId,batch]);
  consumed.push({reservationId,stockMovementId,quantity:a.quantityMm,extended:a.extraMm});
 }
 return consumed;
}
async function restore(batch,consumed,proofs){
 const inverses=[];
 for(const c of consumed){
  await tx.query('UPDATE public.stock_batches SET qty_total=qty_total+$2,qty_reserved=qty_reserved+$2-$3 WHERE id=$1',[batch,c.quantity,c.extended]);
  await tx.query("UPDATE public.stock_reservations SET qty_reserved=qty_reserved-$3,qty_consumed=qty_consumed-$2,status='ACTIVE',row_version=row_version+1 WHERE id=$1",[c.reservationId,c.quantity,c.extended]);
  const movementId=id(),owner=materialBarCorrectionPostingOwner(tx,proofs,c.stockMovementId,movementId);assert.ok(owner);
  consumeMaterialBarPostingOwner(tx,owner,{id:movementId,batchId:batch,type:'IN',quantity:c.quantity,reversalOf:c.stockMovementId});
  await tx.query("INSERT INTO public.stock_movements(id,stock_batch_id,status) VALUES($1,$2,'POSTED')",[movementId,batch]);inverses.push({reservationId:c.reservationId,movementId});
 }
 return inverses;
}
async function main(){
 await tx.connect();assert.equal((await tx.query('SELECT current_database() AS db')).rows[0].db,'material_bars_1246');
 await tx.query('INSERT INTO public.users VALUES(1246) ON CONFLICT DO NOTHING');
 const f=await setup([1000,500],[{b:0,r:'a',q:210},{b:0,r:'b',q:11},{b:1,r:'other',q:300}]);
 const sources=[{reservationId:f.r('a'),batchId:f.batch,quantity:210,bars:[{barId:f.barIds[0],expectedVersion:1,quantity:210}]},
  {reservationId:f.r('b'),batchId:f.batch,quantity:11,bars:[{barId:f.barIds[0],expectedVersion:1,quantity:11}]}];
 assert.throws(()=>materialBarConsumptionExtra({reservationId:f.r('a'),quantityMm:210,extraMm:0,barIds:[f.barIds[0]]},f.r('a'),210),/parcours de découpe/);pass('a forged partial-consumption authorization is rejected');
 await tx.query('BEGIN');let plan=await prepareMaterialBarDebitTx(tx,sources),consumed=await post(plan,f.batch);
 await applyMaterialBarDebitTx(tx,plan,{commandKey:id(),actor:1246,reason:'Fixture failure after physical write',consumed});
 await tx.query('ROLLBACK');let stock=await readMaterialBarInventoryTx(tx,f.batch);
 assert.equal(stock.batch.physicalMm,1500);assert.equal(stock.batch.reservedMm,521);assert.equal(stock.bars.find(b=>b.id===f.barIds[0]).lengthMm,1000);
 assert.equal((await tx.query("SELECT count(*)::int AS n FROM public.stock_material_bar_events WHERE bar_id=$1 AND action='CUT'",[f.barIds[0]])).rows[0].n,0);
 pass('downstream failure rolls back canonical postings, geometry, holds and cut history');
 const commandKey=id();await tx.query('BEGIN');plan=await prepareMaterialBarDebitTx(tx,sources);consumed=await post(plan,f.batch);
 await applyMaterialBarDebitTx(tx,plan,{commandKey,actor:1246,reason:'Two source holds fund one physical cut',consumed});await tx.query('COMMIT');
 stock=await readMaterialBarInventoryTx(tx,f.batch);assert.equal(stock.status,'CONFIRMED');assert.equal(stock.batch.physicalMm,1279);assert.equal(stock.batch.reservedMm,300);
 assert.equal(stock.bars.find(b=>b.id===f.barIds[0]).lengthMm,779);assert.equal(stock.holds.length,1);assert.equal(stock.holds[0].reservationId,f.r('other'));
 const event=(await tx.query("SELECT before_state,after_state FROM public.stock_material_bar_events WHERE command_key=$1 AND action='CUT'",[commandKey])).rows[0];
 assert.equal(event.after_state.sources.length,2);assert.deepEqual(new Set(event.after_state.sources.map(s=>s.stockMovementId)),new Set(consumed.map(s=>s.stockMovementId)));
 pass('shared-bar cut posts once with both source movements and preserves the other OF');
 const originals=consumed.map(c=>({reservationId:c.reservationId,movementId:c.stockMovementId,quantity:c.quantity,extended:c.extended}));
 await tx.query('BEGIN');await tx.query('UPDATE public.stock_material_bars SET row_version=row_version+1 WHERE id=$1',[f.barIds[0]]);
 await assert.rejects(prepareMaterialBarCorrectionTx(tx,commandKey,originals),/changé/);await tx.query('ROLLBACK');pass('a later bar change refuses compensation before any inverse posting');
 await tx.query('BEGIN');let proofs=await prepareMaterialBarCorrectionTx(tx,commandKey,originals);assert.equal(proofs.length,1);
 let inverses=await restore(f.batch,consumed,proofs);await applyMaterialBarCorrectionTx(tx,proofs,{commandKey:id(),actor:1246,reason:'Correction of fixture cut',inverses});await tx.query('COMMIT');
 stock=await readMaterialBarInventoryTx(tx,f.batch);assert.equal(stock.status,'CONFIRMED');assert.equal(stock.batch.physicalMm,1500);assert.equal(stock.batch.reservedMm,521);
 assert.equal(stock.bars.find(b=>b.id===f.barIds[0]).lengthMm,1000);assert.equal(stock.bars.find(b=>b.id===f.barIds[0]).version,3);assert.equal(stock.holds.length,3);
 pass('compensation restores exact source holds and length with a new monotonic version');
 await tx.query('BEGIN');await assert.rejects(prepareMaterialBarCorrectionTx(tx,commandKey,originals),/changé/);await tx.query('ROLLBACK');pass('the same cut cannot restore the physical bar twice');
 const g=await setup([500,500],[{b:0,r:'a',q:100},{b:1,r:'a',q:100},{b:1,r:'other',q:50}]);
 const closure=[{reservationId:g.r('a'),batchId:g.batch,quantity:100,bars:[{barId:g.barIds[0],expectedVersion:1,quantity:100,
  barClosure:{discardedQuantity:400,acknowledgedLargeRemainder:false}}]}];
 await tx.query('BEGIN');await assert.rejects(prepareMaterialBarDebitTx(tx,closure),/150 mm/);await tx.query('ROLLBACK');pass('large discarded remainder requires explicit acknowledgement');
 closure[0].bars[0].barClosure.acknowledgedLargeRemainder=true;const closeKey=id();
 await tx.query('BEGIN');plan=await prepareMaterialBarDebitTx(tx,closure);assert.equal(plan.consumptions.get(g.r('a')).extraMm,400);
 consumed=await post(plan,g.batch);await applyMaterialBarDebitTx(tx,plan,{commandKey:closeKey,actor:1246,reason:'Close the first physical bar',consumed});await tx.query('COMMIT');
 stock=await readMaterialBarInventoryTx(tx,g.batch);assert.equal(stock.status,'CONFIRMED');assert.equal(stock.batch.physicalMm,500);assert.equal(stock.batch.reservedMm,150);
 assert.equal(stock.bars.find(b=>b.id===g.barIds[0]).lengthMm,0);assert.equal(stock.holds.find(h=>h.reservationId===g.r('a')).remainingMm,100);
 pass('closure extends only the discarded free length and preserves its own hold on another bar');
 await tx.query('BEGIN');proofs=await prepareMaterialBarCorrectionTx(tx,closeKey,consumed.map(c=>({reservationId:c.reservationId,movementId:c.stockMovementId,quantity:c.quantity,extended:c.extended})));
 inverses=await restore(g.batch,consumed,proofs);await applyMaterialBarCorrectionTx(tx,proofs,{commandKey:id(),actor:1246,reason:'Correct physical bar closure',inverses});await tx.query('COMMIT');
 stock=await readMaterialBarInventoryTx(tx,g.batch);assert.equal(stock.status,'CONFIRMED');assert.equal(stock.batch.physicalMm,1000);assert.equal(stock.batch.reservedMm,250);
 assert.equal(stock.reservations.find(r=>r.id===g.r('a')).remainingMm,200);pass('closure compensation removes its temporary extension and restores both original holds');
 console.log(`MATERIAL1246_DEBIT_REPOSITORY_PASS: ${passed} real PostgreSQL debit/correction checks`);
}
main().catch(error=>{console.error(error.name+': '+error.message);process.exitCode=1;}).finally(()=>tx.end());
