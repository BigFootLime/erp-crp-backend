/* Isolated real PostgreSQL repositories; canonical ledger counters are simulated.
 * Full ERP schema / HTTP acceptance is a separate release prerequisite. */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{randomUUID:id}=require('node:crypto'),{Client}=require('pg');
const load=name=>require(path.join(process.env.MATERIAL_BAR_COMPILED_ROOT,`src/module/stock/repository/${name}.repository.js`));
const {readMaterialBarInventoryTx}=load('material-bar-inventory');
const {prepareMaterialBarMovementTx,applyMaterialBarMovementTx}=load('material-bar-movement');
const {prepareMaterialBarCompensationTx,applyMaterialBarCompensationTx,previewMaterialBarCompensationTx}=load('material-bar-compensation');
const {lockMaterialBarPostingScopeTx,prepareMaterialBarPostingTx,applyMaterialBarPostingTx}=load('material-bar-posting');
const {planMaterialBarReservation,allocateMaterialBarReservationTx}=load('material-bar-holds');
const config=JSON.parse(fs.readFileSync(0,'utf8'));assert.equal(config.database,'material_bars_1246');
const tx=new Client(config);let passed=0;const pass=label=>{passed++;console.log(`PASS: ${label}`);};
const selection=b=>({barId:b.id,expectedVersion:b.version});
async function setup(existing){
 const article=existing?.article??id(),lot=existing?.lot??id(),level=id(),batch=id();
 if(!existing){await tx.query("INSERT INTO public.articles VALUES($1,'BAR-CORRECTION','Compensation fixture bar','mm')",[article]);await tx.query("INSERT INTO public.lots VALUES($1,$2,'COMP-FIXTURE')",[lot,article]);}
 await tx.query('INSERT INTO public.stock_levels VALUES($1,$2)',[level,article]);await tx.query('INSERT INTO public.stock_batches VALUES($1,$2,$3,0,0)',[batch,lot,level]);return {article,lot,batch};
}
async function insert(f,type,quantity,reversalOf=null){
 const movement=id();await tx.query("INSERT INTO public.stock_movements(id,stock_batch_id,article_id,qty,status,movement_type,reversal_of_id) VALUES($1,$2,$3,$4,'DRAFT',$5,$6)",[movement,f.batch,f.article,quantity,type,reversalOf]);return movement;
}
async function ledger(f,movement,type,quantity,destination){
 await tx.query("UPDATE public.stock_movements SET status='POSTED' WHERE id=$1",[movement]);
 const delta=['ADJUST','ADJUSTMENT'].includes(type)?quantity:type==='IN'?quantity:-quantity;
 await tx.query('UPDATE public.stock_batches SET qty_total=qty_total+$2 WHERE id=$1',[f.batch,delta]);
 if(destination){
  await tx.query("INSERT INTO public.stock_movements(id,stock_batch_id,article_id,qty,status,movement_type,doc_type,doc_id) VALUES($1,$2,$3,$4,'POSTED','OUT','STOCK_TRANSFER_INTERNAL',$5),($6,$7,$3,$4,'POSTED','IN','STOCK_TRANSFER_INTERNAL',$5)",[id(),f.batch,f.article,quantity,movement,id(),destination.batch]);
  await tx.query('UPDATE public.stock_batches SET qty_total=qty_total+$2 WHERE id=$1',[destination.batch,quantity]);
 }
}
async function move(f,kind,quantity,bars,destination,type){
 await tx.query('BEGIN');const stock=await readMaterialBarInventoryTx(tx,f.batch),target=destination?await readMaterialBarInventoryTx(tx,destination.batch):null;
 type??={RECEIVE:'IN',ISSUE:'OUT',TRANSFER:'TRANSFER'}[kind];const movement=await insert(f,type,quantity);
 const p=await prepareMaterialBarMovementTx(tx,{movementId:movement,sourceBatchId:f.batch,destinationBatchId:destination?.batch,
  command:{kind,expectedVersion:stock.version,...(target?{expectedDestinationVersion:target.version}:{}),bars}});
 await ledger(f,movement,type,quantity,destination);await applyMaterialBarMovementTx(tx,p,1246);await tx.query('COMMIT');return movement;
}
async function inverse(f,original,type,quantity,destination){
 await tx.query('BEGIN');const movement=await insert(f,type,quantity,original);
 const scope=await lockMaterialBarPostingScopeTx(tx,{articleId:f.article,lotIds:[f.lot],explicit:false});
 const token=await prepareMaterialBarPostingTx(tx,{scope,movement:{id:movement,batchId:f.batch,type,quantity,reversalOf:original},destinationBatchId:destination?.batch,externalTransaction:false});
 await ledger(f,movement,type,quantity,destination);await applyMaterialBarPostingTx(tx,token,1246);await tx.query('COMMIT');return {movement,token};
}
async function main(){
 await tx.connect();assert.equal((await tx.query('SELECT current_database() AS name')).rows[0].name,'material_bars_1246');
 const f=await setup();const entry=await move(f,'RECEIVE',6000,[{lengthMm:3000,count:2}]);let initial=await readMaterialBarInventoryTx(tx,f.batch);
 const bar=initial.bars[0],cut=await move(f,'ISSUE',1000,[{...selection(bar),quantityMm:1000}]);
 await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');assert.equal(await previewMaterialBarCompensationTx(tx,cut),true);await tx.query('COMMIT');pass('read-only preview confirms exact original bars before creating an inverse draft');
 const restored=await inverse(f,cut,'IN',1000);let current=await readMaterialBarInventoryTx(tx,f.batch);
 assert.equal(current.batch.physicalMm,6000);assert.equal(current.bars.find(b=>b.id===bar.id).lengthMm,3000);assert.equal(current.bars.length,2);assert.equal(current.bars.find(b=>b.id===bar.id).version,3);pass('inverse OUT restores the original barcode and length, never creates a new bar');
 await tx.query('BEGIN');await assert.rejects(applyMaterialBarCompensationTx(tx,restored.token,1246),e=>e.code==='MATERIAL_BAR_COMPENSATION_CHANGED');await tx.query('ROLLBACK');pass('consumed compensation token cannot be replayed');
 await tx.query('BEGIN');const duplicate=await insert(f,'IN',1000,cut);await assert.rejects(prepareMaterialBarCompensationTx(tx,{movementId:duplicate}),e=>e.code==='MATERIAL_BAR_COMPENSATION_CHANGED');await tx.query('ROLLBACK');pass('second inverse cannot compensate the same movement twice');
 const fullBar=current.bars.find(b=>b.id!==bar.id),fullCut=await move(f,'ISSUE',3000,[{...selection(fullBar),quantityMm:3000}]);
 assert.equal((await readMaterialBarInventoryTx(tx,f.batch)).bars.find(b=>b.id===fullBar.id).lengthMm,0);
 await inverse(f,fullCut,'IN',3000);assert.equal((await readMaterialBarInventoryTx(tx,f.batch)).bars.find(b=>b.id===fullBar.id).lengthMm,3000);pass('a fully consumed bar is restored under its existing identity');
 const incoming=await setup(),incomingMove=await move(incoming,'RECEIVE',6000,[{lengthMm:3000,count:2}]);const incomingBars=(await readMaterialBarInventoryTx(tx,incoming.batch)).bars;
 await inverse(incoming,incomingMove,'OUT',6000);current=await readMaterialBarInventoryTx(tx,incoming.batch);
 assert.equal(current.status,'CONFIRMED');assert.equal(current.batch.physicalMm,0);assert.equal(current.bars.length,0);
 const retired=(await tx.query('SELECT id,retired_at,initial_length_mm FROM public.stock_material_bars WHERE id=ANY($1::uuid[])',[incomingBars.map(b=>b.id)])).rows;
 assert.equal(retired.length,2);assert.ok(retired.every(b=>b.retired_at&&Number(b.initial_length_mm)===3000));pass('inverse entry retires unused bar identities while retaining their immutable history');
 const transferSource=await setup(),dest=await setup(transferSource);await move(transferSource,'RECEIVE',6000,[{lengthMm:3000,count:2}]);const transferBars=(await readMaterialBarInventoryTx(tx,transferSource.batch)).bars;
 const transfer=await move(transferSource,'TRANSFER',6000,transferBars.map(selection),dest);await inverse(dest,transfer,'TRANSFER',6000,transferSource);
 current=await readMaterialBarInventoryTx(tx,transferSource.batch);assert.equal(current.status,'CONFIRMED');assert.deepEqual(current.bars.map(b=>b.id).sort(),transferBars.map(b=>b.id).sort());assert.ok(current.bars.every(b=>b.version===3));assert.equal((await readMaterialBarInventoryTx(tx,dest.batch)).batch.physicalMm,0);pass('inverse transfer returns all original barcodes with canonical legs and SQL relocation proofs');
 const adjusted=await setup();await move(adjusted,'RECEIVE',3000,[{lengthMm:3000,count:1}]);let a=(await readMaterialBarInventoryTx(tx,adjusted.batch)).bars[0];
 const adjustment=await move(adjusted,'ISSUE',-0.001,[{...selection(a),quantityMm:0.001}],undefined,'ADJUSTMENT');await inverse(adjusted,adjustment,'ADJUSTMENT',0.001);assert.equal((await readMaterialBarInventoryTx(tx,adjusted.batch)).bars[0].lengthMm,3000);pass('fractional negative adjustment restores exactly 0.001 mm');
 a=(await readMaterialBarInventoryTx(tx,adjusted.batch)).bars[0];const first=await move(adjusted,'ISSUE',500,[{...selection(a),quantityMm:500}]);a=(await readMaterialBarInventoryTx(tx,adjusted.batch)).bars[0];await move(adjusted,'ISSUE',500,[{...selection(a),quantityMm:500}]);
 await tx.query('BEGIN');let bad=await insert(adjusted,'IN',500,first);await assert.rejects(prepareMaterialBarCompensationTx(tx,{movementId:bad}),e=>e.code==='MATERIAL_BAR_COMPENSATION_CHANGED');await tx.query('ROLLBACK');assert.equal((await readMaterialBarInventoryTx(tx,adjusted.batch)).bars[0].lengthMm,2000);pass('later physical use blocks stale correction without changing stock');
 await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await assert.rejects(previewMaterialBarCompensationTx(tx,first),e=>e.code==='MATERIAL_BAR_COMPENSATION_CHANGED');await tx.query('ROLLBACK');pass('preview exposes a later cut before the user creates a doomed correction');
 await tx.query('BEGIN');bad=await insert(adjusted,'IN',499,first);await assert.rejects(prepareMaterialBarCompensationTx(tx,{movementId:bad}),e=>e.code==='MATERIAL_BAR_COMPENSATION_CHANGED');await tx.query('ROLLBACK');pass('altered inverse quantity is rejected before posting');
 const reserved=await setup(),reservedEntry=await move(reserved,'RECEIVE',3000,[{lengthMm:3000,count:1}]);current=await readMaterialBarInventoryTx(tx,reserved.batch);
 await tx.query('BEGIN');const r=id(),plan=planMaterialBarReservation(current,1000);await tx.query("INSERT INTO public.stock_reservations(id,stock_batch_id,qty_reserved,qty_consumed,status) VALUES($1,$2,1000,0,'ACTIVE')",[r,reserved.batch]);await tx.query('UPDATE public.stock_batches SET qty_reserved=1000 WHERE id=$1',[reserved.batch]);await allocateMaterialBarReservationTx(tx,current,plan,{reservationId:r,actor:1246,commandKey:id(),reason:'Compensation fixture reservation'});await tx.query('COMMIT');
 await tx.query('BEGIN');bad=await insert(reserved,'OUT',3000,reservedEntry);await assert.rejects(prepareMaterialBarCompensationTx(tx,{movementId:bad}),e=>e.code==='MATERIAL_BAR_COMPENSATION_CHANGED');await tx.query('ROLLBACK');pass('an incoming bar reserved to an OF cannot be removed by compensation');
 current=await readMaterialBarInventoryTx(tx,reserved.batch);const holds=current.holds,freeCut=await move(reserved,'ISSUE',500,[{...selection(current.bars[0]),quantityMm:500}]);await inverse(reserved,freeCut,'IN',500);current=await readMaterialBarInventoryTx(tx,reserved.batch);assert.deepEqual(current.holds,holds);assert.equal(current.batch.reservedMm,1000);assert.equal(current.batch.physicalMm,3000);pass('restoring a free tail preserves the OF material reservation');
 // Fail after ledger posting and verify transaction rollback restores everything.
 current=await readMaterialBarInventoryTx(tx,adjusted.batch);a=current.bars[0];const latest=await move(adjusted,'ISSUE',100,[{...selection(a),quantityMm:100}]);const baseline=await readMaterialBarInventoryTx(tx,adjusted.batch);
 await tx.query('BEGIN');bad=await insert(adjusted,'IN',100,latest);const token=await prepareMaterialBarCompensationTx(tx,{movementId:bad});
 await assert.rejects(applyMaterialBarCompensationTx({query:tx.query.bind(tx)},token,1246),e=>e.code==='MATERIAL_BAR_COMPENSATION_CHANGED');
 await ledger(adjusted,bad,'IN',100);await tx.query('UPDATE public.stock_material_bars SET row_version=row_version+1 WHERE id=$1',[a.id]);await assert.rejects(applyMaterialBarCompensationTx(tx,token,1246),e=>e.code==='MATERIAL_BAR_COMPENSATION_CHANGED');await tx.query('ROLLBACK');
 assert.equal((await readMaterialBarInventoryTx(tx,adjusted.batch)).version,baseline.version);pass('cross-client token and changed geometry reject the correction atomically');
 console.log(`MATERIAL1246_COMPENSATION_REPOSITORY_PASS: ${passed} real PostgreSQL adapter checks`);
}
main().catch(async error=>{try{await tx.query('ROLLBACK');}catch{}console.error(error);process.exitCode=1;}).finally(()=>tx.end());
