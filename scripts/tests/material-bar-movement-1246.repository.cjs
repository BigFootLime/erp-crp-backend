/* Isolated PostgreSQL adapter tests. Canonical ledger posting is represented
 * explicitly; these do not replace repoPostMovement/full ERP route acceptance. */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{randomUUID:id}=require('node:crypto'),{Client}=require('pg');
const load=name=>require(path.join(process.env.MATERIAL_BAR_COMPILED_ROOT,`src/module/stock/repository/${name}.repository.js`));
const {readMaterialBarInventoryTx}=load('material-bar-inventory');
const {prepareMaterialBarMovementTx,applyMaterialBarMovementTx}=load('material-bar-movement');
const {planMaterialBarReservation,allocateMaterialBarReservationTx}=load('material-bar-holds');
const {lockMaterialBarPostingScopeTx,prepareMaterialBarPostingTx}=load('material-bar-posting');
const {prepareMaterialBarReceiptTx,applyMaterialBarReceiptTx}=load('material-bar-receipt');
const config=JSON.parse(fs.readFileSync(0,'utf8'));assert.equal(config.database,'material_bars_1246');
const tx=new Client(config);let passed=0;const pass=label=>{passed++;console.log(`PASS: ${label}`);};
async function setup(existing){
 const article=existing?.article??id(),lot=existing?.lot??id(),level=id(),batch=id();
 if(!existing){await tx.query("INSERT INTO public.articles VALUES($1,'BAR-MOVE','Movement fixture bar','mm')",[article]);await tx.query("INSERT INTO public.lots VALUES($1,$2,'MOVE-FIXTURE')",[lot,article]);}
 await tx.query('INSERT INTO public.stock_levels VALUES($1,$2)',[level,article]);
 await tx.query('INSERT INTO public.stock_batches VALUES($1,$2,$3,0,0)',[batch,lot,level]);
 return {article,lot,batch};
}
async function prepare(f,quantity,kind,bars,dest,type){
 const movement=id(),source=await readMaterialBarInventoryTx(tx,f.batch),destination=dest?await readMaterialBarInventoryTx(tx,dest.batch):null;
 await tx.query("INSERT INTO public.stock_movements(id,stock_batch_id,article_id,qty,status,movement_type) VALUES($1,$2,$3,$4,'DRAFT',$5)",[movement,f.batch,f.article,quantity,type??({RECEIVE:'IN',ISSUE:'OUT',TRANSFER:'TRANSFER'})[kind]]);
 return prepareMaterialBarMovementTx(tx,{movementId:movement,sourceBatchId:f.batch,destinationBatchId:dest?.batch,
   command:{kind,expectedVersion:source.version,...(destination?{expectedDestinationVersion:destination.version}:{}),bars}});
}
async function ledger(p,omitIn=false){
 const m=p.movement,q=Math.abs(m.quantity);
 await tx.query("UPDATE public.stock_movements SET status='POSTED' WHERE id=$1",[m.id]);
 const delta=p.plan.kind==='RECEIVE'?q:-q;
 await tx.query('UPDATE public.stock_batches SET qty_total=qty_total+$2 WHERE id=$1',[p.source.batch.id,delta]);
 if(p.plan.kind==='TRANSFER'){
  await tx.query("INSERT INTO public.stock_movements(id,stock_batch_id,article_id,qty,status,movement_type,doc_type,doc_id) VALUES($1,$2,$3,$4,'POSTED','OUT','STOCK_TRANSFER_INTERNAL',$5)",[id(),p.source.batch.id,m.articleId,q,m.id]);
  if(!omitIn){
   await tx.query("INSERT INTO public.stock_movements(id,stock_batch_id,article_id,qty,status,movement_type,doc_type,doc_id) VALUES($1,$2,$3,$4,'POSTED','IN','STOCK_TRANSFER_INTERNAL',$5)",[id(),p.destination.batch.id,m.articleId,q,m.id]);
   await tx.query('UPDATE public.stock_batches SET qty_total=qty_total+$2 WHERE id=$1',[p.destination.batch.id,q]);
  }
 }
}
async function receive(f,groups,type='IN'){
 const quantity=groups.reduce((sum,g)=>sum+g.count*g.lengthMm,0);await tx.query('BEGIN');
 const p=await prepare(f,quantity,'RECEIVE',groups,undefined,type);await ledger(p);const [result]=await applyMaterialBarMovementTx(tx,p,1246);await tx.query('COMMIT');return result;
}
const selection=bar=>({barId:bar.id,expectedVersion:bar.version});
async function main(){
 await tx.connect();assert.equal((await tx.query('SELECT current_database() AS name')).rows[0].name,'material_bars_1246');
 const f=await setup(),dest=await setup(f);let current=await receive(f,[{lengthMm:3000,count:2}]);
 assert.equal(current.status,'CONFIRMED');assert.equal(current.batch.physicalMm,6000);assert.equal(current.bars.length,2);pass('generic entry records actual 3 m bars and reconciles its posted ledger');
 const oldBars=current.bars;current=await receive(f,[{lengthMm:1000,count:1}],'ADJUSTMENT');
 assert.equal(current.batch.physicalMm,7000);assert.deepEqual(current.bars.filter(b=>oldBars.some(o=>o.id===b.id)),oldBars);pass('positive adjustment appends known bars without rewriting existing identities');
 const reservedBar=current.bars[0],r=id();await tx.query('BEGIN');
 const alloc=planMaterialBarReservation(current,500);await tx.query("INSERT INTO public.stock_reservations(id,stock_batch_id,qty_reserved,qty_consumed,status) VALUES($1,$2,500,0,'ACTIVE')",[r,f.batch]);
 await tx.query('UPDATE public.stock_batches SET qty_reserved=500 WHERE id=$1',[f.batch]);
 await allocateMaterialBarReservationTx(tx,current,alloc,{reservationId:r,actor:1246,commandKey:id(),reason:'Physical movement fixture reservation'});await tx.query('COMMIT');
 current=await readMaterialBarInventoryTx(tx,f.batch);const heldBar=current.bars.find(b=>current.holds.some(h=>h.barId===b.id));assert.ok(heldBar);
 const before=current;await tx.query('BEGIN');const issue=await prepare(f,250,'ISSUE',[{...selection(heldBar),quantityMm:250}]);await ledger(issue);[current]=await applyMaterialBarMovementTx(tx,issue,1246);await tx.query('COMMIT');
 assert.equal(current.batch.physicalMm,6750);assert.equal(current.bars.find(b=>b.id===heldBar.id).lengthMm,heldBar.lengthMm-250);assert.deepEqual(current.holds,before.holds);assert.deepEqual(current.reservations,before.reservations);pass('free tail issue leaves OF reservation quantities and ownership intact');
 const free=current.bars.find(b=>b.id!==heldBar.id);await tx.query('BEGIN');const negative=await prepare(f,-0.001,'ISSUE',[{...selection(free),quantityMm:0.001}],undefined,'ADJUSTMENT');await ledger(negative);[current]=await applyMaterialBarMovementTx(tx,negative,1246);await tx.query('COMMIT');
 assert.equal(current.bars.find(b=>b.id===free.id).lengthMm,free.lengthMm-0.001);pass('negative adjustment preserves an exact 0.001 mm decrement');
 await tx.query('BEGIN');const reservedNow=current.bars.find(b=>b.id===heldBar.id);await assert.rejects(prepare(f,reservedNow.lengthMm,'TRANSFER',[selection(reservedNow)],dest),e=>e.code==='MATERIAL_BAR_MOVEMENT_CHANGED');await tx.query('ROLLBACK');pass('whole-bar transfer refuses a bar still reserved by an OF');
 const moved=current.bars.find(b=>b.id===free.id);await tx.query('BEGIN');const transfer=await prepare(f,moved.lengthMm,'TRANSFER',[selection(moved)],dest);await ledger(transfer);let [sourceAfter,destAfter]=await applyMaterialBarMovementTx(tx,transfer,1246);await tx.query('ROLLBACK');
 assert.equal((await readMaterialBarInventoryTx(tx,dest.batch)).bars.length,0);assert.ok((await readMaterialBarInventoryTx(tx,f.batch)).bars.some(b=>b.id===moved.id));assert.equal((await tx.query('SELECT count(*)::int AS n FROM public.stock_movements WHERE id=$1 OR doc_id=$1',[transfer.movement.id])).rows[0].n,0);pass('rollback removes both transfer legs, location changes and immutable proofs together');
 const destSeed=await receive(dest,[{lengthMm:1200,count:1}]);await tx.query('BEGIN');const transfer2=await prepare(f,moved.lengthMm,'TRANSFER',[selection(moved)],dest);await ledger(transfer2);[sourceAfter,destAfter]=await applyMaterialBarMovementTx(tx,transfer2,1246);await tx.query('COMMIT');
 assert.equal(destAfter.status,'CONFIRMED');assert.deepEqual(destAfter.bars.find(b=>b.id===moved.id),{...moved,batchId:dest.batch,version:moved.version+1});assert.deepEqual(destAfter.bars.find(b=>b.id===destSeed.bars[0].id),destSeed.bars[0]);assert.deepEqual(sourceAfter.holds,current.holds);assert.equal(sourceAfter.batch.reservedMm,500);pass('transfer keeps barcode identity, initial length and history while other bars stay reserved');
 await tx.query('BEGIN');await assert.rejects(applyMaterialBarMovementTx(tx,transfer2,1246),e=>e.code==='MATERIAL_BAR_MOVEMENT_CHANGED');await tx.query('ROLLBACK');pass('a completed plan cannot replay and duplicate geometry');
 await tx.query('BEGIN');await assert.rejects(tx.query('UPDATE public.stock_material_bars SET stock_batch_id=$2,row_version=row_version+1 WHERE id=$1',[moved.id,f.batch]),e=>e.code==='23514');await tx.query('ROLLBACK');pass('SQL rejects a direct bar relocation without its own immutable transfer proof');
 current=await readMaterialBarInventoryTx(tx,f.batch);const available=current.bars.find(b=>!current.holds.some(h=>h.barId===b.id));assert.ok(available);
 await tx.query('BEGIN');const incomplete=await prepare(f,available.lengthMm,'TRANSFER',[selection(available)],dest);await ledger(incomplete,true);await assert.rejects(applyMaterialBarMovementTx(tx,incomplete,1246),e=>e.code==='MATERIAL_BAR_MOVEMENT_CHANGED');await tx.query('ROLLBACK');pass('missing canonical IN leg rejects a transfer even when the source quantity changed');
 await tx.query('BEGIN');const unposted=await prepare(f,1,'ISSUE',[{...selection(available),quantityMm:1}]);await assert.rejects(applyMaterialBarMovementTx(tx,unposted,1246),e=>e.code==='MATERIAL_BAR_MOVEMENT_CHANGED');await tx.query('ROLLBACK');pass('unposted movements never change physical bar lengths');
 await tx.query('BEGIN');const wrongTotal=await prepare(f,1,'ISSUE',[{...selection(available),quantityMm:1}]);await ledger(wrongTotal);await tx.query('UPDATE public.stock_batches SET qty_total=qty_total+1 WHERE id=$1',[f.batch]);await assert.rejects(applyMaterialBarMovementTx(tx,wrongTotal,1246),e=>e.code==='MATERIAL_BAR_MOVEMENT_CHANGED');await tx.query('ROLLBACK');pass('canonical balance mismatch is rejected before altering bars');
 await tx.query('BEGIN');const hidden=await prepare(f,1,'ISSUE',[{...selection(available),quantityMm:1}]);await ledger(hidden);for(const type of ['IN','OUT'])await tx.query("INSERT INTO public.stock_movements(id,stock_batch_id,article_id,qty,status,movement_type) VALUES($1,$2,$3,1,'POSTED',$4)",[id(),f.batch,f.article,type]);await assert.rejects(applyMaterialBarMovementTx(tx,hidden,1246),e=>e.code==='MATERIAL_BAR_MOVEMENT_CHANGED');await tx.query('ROLLBACK');pass('movement watermark detects hidden IN/OUT even when their net quantity is zero');
 await tx.query('BEGIN');const modified=await prepare(f,1,'ISSUE',[{...selection(available),quantityMm:1}]);await ledger(modified);await tx.query('UPDATE public.stock_material_bars SET row_version=row_version+1 WHERE id=$1',[available.id]);await assert.rejects(applyMaterialBarMovementTx(tx,modified,1246),e=>e.code==='MATERIAL_BAR_MOVEMENT_CHANGED');await tx.query('ROLLBACK');pass('stale physical bar version rejects the post without overwriting its change');
 await tx.query('BEGIN');await assert.rejects(prepare(f,1,'RECEIVE',[{lengthMm:1,count:1}],undefined,'OUT'),e=>e.code==='MATERIAL_BAR_MOVEMENT_CHANGED');await tx.query('ROLLBACK');pass('receipt geometry cannot be supplied to a canonical OUT');
 const second=new Client(config);await second.connect();try{
  await tx.query('BEGIN');const locked=await prepare(f,1,'ISSUE',[{...selection(available),quantityMm:1}]);
  await assert.rejects(applyMaterialBarMovementTx(second,locked,1246),e=>e.code==='MATERIAL_BAR_MOVEMENT_CHANGED');pass('a prepared physical update cannot be applied by another transaction client');
  await second.query('BEGIN');await second.query("SET LOCAL lock_timeout='150ms'");
  await assert.rejects(second.query('UPDATE public.stock_material_bars SET remaining_length_mm=remaining_length_mm-1 WHERE id=$1',[available.id]),e=>e.code==='55P03');
  await second.query('ROLLBACK');await tx.query('ROLLBACK');pass('concurrent bar changes wait on the prepared stock transaction instead of overspending');
 }finally{await second.end();}
 current=await readMaterialBarInventoryTx(tx,f.batch);assert.equal(current.status,'CONFIRMED');assert.equal((await readMaterialBarInventoryTx(tx,dest.batch)).status,'CONFIRMED');
 const multi=await setup(),multiDest=await setup(multi),multiStock=await receive(multi,[{lengthMm:3000,count:2}]);
 await tx.query('BEGIN');const multiple=await prepare(multi,6000,'TRANSFER',multiStock.bars.map(selection),multiDest);await ledger(multiple);const [empty,multipleDest]=await applyMaterialBarMovementTx(tx,multiple,1246);await tx.query('COMMIT');
 assert.equal(empty.batch.physicalMm,0);assert.equal(empty.bars.length,0);assert.equal(multipleDest.batch.physicalMm,6000);assert.deepEqual(multipleDest.bars.map(b=>b.id).sort(),multiStock.bars.map(b=>b.id).sort());pass('a multiple-bar transfer checks the complete 6 m proof before each identity update');
 await tx.query('BEGIN');const back=await prepare(multiDest,6000,'TRANSFER',multipleDest.bars.map(selection),multi);await ledger(back);
 // Forge just one event for a two-bar transfer. Even a direct SQL update must
 // reject the missing physical proof before a barcode can change location.
 const forged=multipleDest.bars[0];await tx.query(`INSERT INTO public.stock_material_bar_events(bar_id,command_key,action,stock_movement_id,before_state,after_state,reason,created_by)
  VALUES($1,$2,'MOVE',$2,$3::jsonb,$4::jsonb,'Incomplete transfer fixture',1246)`,[forged.id,back.movement.id,JSON.stringify(forged),JSON.stringify({...forged,batchId:multi.batch,version:forged.version+1})]);
 await assert.rejects(tx.query('UPDATE public.stock_material_bars SET stock_batch_id=$2,row_version=row_version+1 WHERE id=$1',[forged.id,multi.batch]),e=>e.code==='23514');await tx.query('ROLLBACK');pass('SQL rejects incomplete physical proof even with both canonical transfer legs posted');
 await tx.query('BEGIN');const abandoned=await prepare(f,1,'ISSUE',[{...selection(available),quantityMm:1}]);await ledger(abandoned);
 await assert.rejects(tx.query('COMMIT'),e=>e.code==='23514'&&e.constraint==='stock_material_geometry_complete_1246');await tx.query('ROLLBACK');
 assert.equal((await readMaterialBarInventoryTx(tx,f.batch)).status,'CONFIRMED');pass('COMMIT rolls back a posted legacy movement that forgot to update physical bars');
 await tx.query('BEGIN');await tx.query('UPDATE public.stock_material_bars SET remaining_length_mm=remaining_length_mm-1,row_version=row_version+1 WHERE id=$1',[available.id]);
 await assert.rejects(tx.query('COMMIT'),e=>e.code==='23514');await tx.query('ROLLBACK');pass('COMMIT refuses a physical length change without its canonical stock movement');
 await tx.query('BEGIN');const scope=await lockMaterialBarPostingScopeTx(tx,{articleId:f.article,lotIds:[f.lot],explicit:false});
 const unchanged=await readMaterialBarInventoryTx(tx,f.batch),boundaryMovement=id();await tx.query("INSERT INTO public.stock_movements(id,stock_batch_id,article_id,qty,status,movement_type) VALUES($1,$2,$3,1,'DRAFT','OUT')",[boundaryMovement,f.batch,f.article]);
 const request={scope,movement:{id:boundaryMovement,batchId:f.batch,type:'OUT',quantity:1,reversalOf:null},externalTransaction:true};
 await assert.rejects(prepareMaterialBarPostingTx(tx,request),e=>e.code==='MATERIAL_BAR_MOVEMENT_REQUIRED');
 const boundaryPlan=await prepareMaterialBarPostingTx(tx,{...request,command:{kind:'ISSUE',expectedVersion:unchanged.version,bars:[{...selection(available),quantityMm:1}]}});
 await ledger(boundaryPlan);await applyMaterialBarMovementTx(tx,boundaryPlan,1246);await tx.query('COMMIT');pass('posting boundary requires and applies explicit geometry even with an external transaction');
 const received=await setup();await tx.query('BEGIN');const receiptScope=await lockMaterialBarPostingScopeTx(tx,{articleId:received.article,lotIds:[received.lot],explicit:true});
 const receiptMovement=id();await tx.query("INSERT INTO public.stock_movements(id,stock_batch_id,article_id,qty,status,movement_type) VALUES($1,$2,$3,3000,'DRAFT','IN')",[receiptMovement,received.batch,received.article]);
 const receiptPlan=await prepareMaterialBarReceiptTx(tx,{movementId:receiptMovement,required:true,groups:[{lengthMm:3000,count:1}]});
 assert.equal(await prepareMaterialBarPostingTx(tx,{scope:receiptScope,movement:{id:receiptMovement,batchId:received.batch,type:'IN',quantity:3000,reversalOf:null},owner:receiptPlan.postingOwner,externalTransaction:true}),null);
 await tx.query("UPDATE public.stock_movements SET status='POSTED' WHERE id=$1",[receiptMovement]);await tx.query('UPDATE public.stock_batches SET qty_total=qty_total+3000 WHERE id=$1',[received.batch]);
 await applyMaterialBarReceiptTx(tx,receiptPlan,1246);await tx.query('COMMIT');assert.equal((await readMaterialBarInventoryTx(tx,received.batch)).bars.length,1);pass('managed receipt owner posts once and completes geometry before deferred commit checks');
 const receivedBar=(await readMaterialBarInventoryTx(tx,received.batch)).bars[0];
 for(const type of ['SCRAP','DEPRECIATE']){
  await tx.query('BEGIN');await assert.rejects(prepare(received,100,'ISSUE',[{...selection(receivedBar),quantityMm:100}],undefined,type),e=>e.code==='MATERIAL_BAR_MOVEMENT_CHANGED');await tx.query('ROLLBACK');
  assert.equal((await readMaterialBarInventoryTx(tx,received.batch)).bars[0].lengthMm,3000);pass(`${type} cannot masquerade as physical removal when its canonical quantity stays in stock`);
 }
 console.log(`MATERIAL1246_MOVEMENT_REPOSITORY_PASS: ${passed} real PostgreSQL adapter checks`);
}
main().catch(async error=>{try{await tx.query('ROLLBACK');}catch{}console.error(error);process.exitCode=1;}).finally(()=>tx.end());
