/* Real physical repositories; canonical ownership SQL is a minimal fixture.
 * Never use an ERP database. The short-lived connection arrives on stdin. */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{randomUUID:id}=require('node:crypto'),{Client}=require('pg');
const load=name=>require(path.join(process.env.MATERIAL_BAR_COMPILED_ROOT,`src/module/stock/repository/${name}.repository.js`));
const {readMaterialBarInventoryTx,lockMaterialBarInventoryTx,writeMaterialBarInventoryTx}=load('material-bar-inventory');
const {releaseMaterialBarReservationTx}=load('material-bar-holds');
const {prepareMaterialBarTransferTx,applyMaterialBarTransferTx,prepareMaterialBarRestorationTx,applyMaterialBarRestorationTx}=load('material-bar-transfer');
const config=JSON.parse(fs.readFileSync(0,'utf8'));assert.equal(config.database,'material_bars_1246');
const tx=new Client(config);let passed=0;const pass=label=>{passed++;console.log(`PASS: ${label}`);};
async function setup(lengths,allocations){
 const article=id(),lot=id(),level=id(),batch=id(),bars=lengths.map(()=>id());
 const reservations=new Map([...new Set(allocations.map(a=>a.r))].map(r=>[r,id()]));
 await tx.query("INSERT INTO public.articles VALUES($1,'BAR-TRANSFER','Grouping fixture','mm')",[article]);
 await tx.query("INSERT INTO public.lots VALUES($1,$2,'GROUP-FIXTURE')",[lot,article]);
 await tx.query('INSERT INTO public.stock_levels VALUES($1,$2)',[level,article]);
 await tx.query('INSERT INTO public.stock_batches VALUES($1,$2,$3,$4,$5)',[batch,lot,level,lengths.reduce((a,b)=>a+b,0),allocations.reduce((s,a)=>s+a.q,0)]);
 for(const [key,reservation]of reservations)await tx.query("INSERT INTO public.stock_reservations(id,stock_batch_id,qty_reserved,qty_consumed,status) VALUES($1,$2,$3,0,'ACTIVE')",[reservation,batch,allocations.filter(a=>a.r===key).reduce((s,a)=>s+a.q,0)]);
 await tx.query('BEGIN');const current=await lockMaterialBarInventoryTx(tx,batch);
 await writeMaterialBarInventoryTx(tx,current,{expectedVersion:current.version,idempotencyKey:id(),reason:'Measured regrouping fixture',bars:lengths.map((lengthMm,b)=>({id:bars[b],lengthMm,
  allocations:allocations.filter(a=>a.b===b).map(a=>({reservationId:reservations.get(a.r),quantityMm:a.q}))}))},1246,id());
 await tx.query('COMMIT');return {batch,bars,r:key=>reservations.get(key)};
}
const audit=contextId=>({contextId,commandKey:id(),actor:1246,reason:'Physical grouping fixture'});
async function transfer(f,sourceKeys,target,contextId){
 const sourceIds=sourceKeys.map(f.r),plan=await prepareMaterialBarTransferTx(tx,f.batch,sourceIds,target);
 const quantity=Number((await tx.query('SELECT COALESCE(sum(qty_reserved),0) AS qty FROM public.stock_reservations WHERE id=ANY($1::uuid[])',[sourceIds])).rows[0].qty);
 if(target)await tx.query('UPDATE public.stock_reservations SET qty_reserved=qty_reserved+$2 WHERE id=$1',[target,quantity]);
 else{target=id();await tx.query("INSERT INTO public.stock_reservations(id,stock_batch_id,qty_reserved,qty_consumed,status) VALUES($1,$2,$3,0,'ACTIVE')",[target,f.batch,quantity]);}
 await tx.query("UPDATE public.stock_reservations SET status='RELEASED' WHERE id=ANY($1::uuid[])",[sourceIds]);
 await applyMaterialBarTransferTx(tx,plan,{...audit(contextId),targetReservationId:target});return target;
}
async function restore(f,target,sources,surplus,contextId){
 const groups=[{batchId:f.batch,targetReservationId:target,sources:sources.map(([key,quantityMm])=>({reservationId:f.r(key),quantityMm}))}];
 const plans=await prepareMaterialBarRestorationTx(tx,contextId,groups);
 await tx.query("UPDATE public.stock_reservations SET status='RELEASED' WHERE id=$1",[target]);
 await tx.query("UPDATE public.stock_reservations SET status='ACTIVE' WHERE id=ANY($1::uuid[])",[sources.map(([key])=>f.r(key))]);
 await tx.query('UPDATE public.stock_batches SET qty_reserved=qty_reserved-$2 WHERE id=$1',[f.batch,surplus]);
 await applyMaterialBarRestorationTx(tx,plans,audit(contextId));
}
async function main(){
 await tx.connect();assert.equal((await tx.query('SELECT current_database() AS name')).rows[0].name,'material_bars_1246');
 const f=await setup([1000,500],[{b:0,r:'one',q:221},{b:0,r:'two',q:110.5},{b:1,r:'two',q:110.5},
  {b:1,r:'producer',q:110.5},{b:0,r:'other',q:100},{b:1,r:'recovery',q:55.25}]);
 const context=id(),target=f.r('producer'),before=await readMaterialBarInventoryTx(tx,f.batch);
 await tx.query('BEGIN');await transfer(f,['one','two'],target,context);await tx.query('ROLLBACK');
 assert.deepEqual((await readMaterialBarInventoryTx(tx,f.batch)).holds,before.holds);
 assert.equal((await tx.query("SELECT count(*)::int AS n FROM public.stock_material_bar_events WHERE after_state->>'contextId'=$1",[context])).rows[0].n,0);
 pass('downstream rollback restores canonical ownership, physical holds and event history');
 await tx.query('BEGIN');await transfer(f,['one','two'],target,context);await tx.query('COMMIT');
 let current=await readMaterialBarInventoryTx(tx,f.batch);assert.equal(current.status,'CONFIRMED');
 assert.equal(current.batch.physicalMm,1500);assert.equal(current.batch.reservedMm,before.batch.reservedMm);
 assert.deepEqual(current.holds.filter(h=>h.reservationId===target).map(h=>h.remainingMm).sort((a,b)=>a-b),[221,331.5]);
 assert.equal(current.holds.find(h=>h.reservationId===f.r('other')).remainingMm,100);
 pass('regrouping keeps exact physical bars, other OF holds and canonical stock counters');
 await tx.query('BEGIN');await transfer(f,['recovery'],target,context);await tx.query('COMMIT');
 current=await readMaterialBarInventoryTx(tx,f.batch);assert.equal(current.status,'CONFIRMED');
 assert.equal(current.holds.find(h=>h.barId===f.bars[1]&&h.reservationId===target).remainingMm,276.25);
 pass('recovery addition extends the same producer bar without duplicating physical stock');
 await tx.query('BEGIN');
 await tx.query('UPDATE public.stock_material_bar_reservations SET remaining_length_mm=remaining_length_mm-1 WHERE bar_id=$1 AND reservation_id=$2',[f.bars[0],target]);
 await tx.query('UPDATE public.stock_material_bar_reservations SET remaining_length_mm=remaining_length_mm+1 WHERE bar_id=$1 AND reservation_id=$2',[f.bars[1],target]);
 assert.equal((await readMaterialBarInventoryTx(tx,f.batch)).status,'CONFIRMED');
 await assert.rejects(restore(f,target,[['one',221],['two',221],['recovery',55.25]],110.5,context),e=>e.code==='MATERIAL_BAR_TRANSFER_CHANGED');
 await tx.query('ROLLBACK');pass('same aggregate quantity cannot hide a changed per-bar allocation during restoration');
 await tx.query('BEGIN');
 await tx.query("UPDATE public.stock_reservations SET status='RELEASED' WHERE id=$1",[f.r('other')]);
 await tx.query('UPDATE public.stock_batches SET qty_reserved=qty_reserved-100 WHERE id=$1',[f.batch]);
 await releaseMaterialBarReservationTx(tx,{reservationId:f.r('other'),actor:1246,commandKey:id(),reason:'Unrelated OF cancellation'});
 await tx.query('COMMIT');
 await tx.query('BEGIN');await restore(f,target,[['one',221],['two',221],['recovery',55.25]],110.5,context);await tx.query('COMMIT');
 current=await readMaterialBarInventoryTx(tx,f.batch);assert.equal(current.status,'CONFIRMED');assert.equal(current.batch.physicalMm,1500);
 assert.equal(current.batch.reservedMm,497.25);
 assert.deepEqual(current.holds,before.holds.filter(h=>![target,f.r('other')].includes(h.reservationId)));
 pass('dissolution restores exact initial and recovery pairs after unrelated changes, releasing only surplus');
 await tx.query('BEGIN');await assert.rejects(restore(f,target,[['one',221],['two',221],['recovery',55.25]],110.5,context),e=>e.code==='MATERIAL_BAR_TRANSFER_CHANGED');
 await tx.query('ROLLBACK');pass('the same grouping cannot restore its physical reservations twice');
 await tx.query('BEGIN');const newTarget=await transfer(f,['one','two','recovery'],null,id());await tx.query('COMMIT');
 current=await readMaterialBarInventoryTx(tx,f.batch);assert.equal(current.status,'CONFIRMED');assert.notEqual(newTarget,target);
 assert.equal(current.reservations.find(r=>r.id===newTarget).remainingMm,497.25);pass('restored sources can form a new grouping with new provenance');
 const surplus=await setup([1000],[{b:0,r:'producer',q:200}]),surplusContext=id();
 await tx.query('BEGIN');await transfer(surplus,[],surplus.r('producer'),surplusContext);await tx.query('COMMIT');
 await tx.query('BEGIN');await restore(surplus,surplus.r('producer'),[],200,surplusContext);await tx.query('COMMIT');
 current=await readMaterialBarInventoryTx(tx,surplus.batch);assert.equal(current.status,'CONFIRMED');assert.equal(current.batch.reservedMm,0);assert.equal(current.batch.physicalMm,1000);
 pass('surplus-only bar holds are journaled and released without inventing source reservations');
 console.log(`MATERIAL1246_TRANSFER_REPOSITORY_PASS: ${passed} real PostgreSQL ownership checks`);
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>tx.end());
