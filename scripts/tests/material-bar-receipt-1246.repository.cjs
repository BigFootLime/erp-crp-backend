/* Real physical receipt repository against a disposable minimal posting fixture.
 * Credentials arrive on stdin; never run against an ERP database. */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{randomUUID:id}=require('node:crypto'),{Client}=require('pg');
const load=name=>require(path.join(process.env.MATERIAL_BAR_COMPILED_ROOT,`src/module/stock/repository/${name}.repository.js`));
const {readMaterialBarInventoryTx}=load('material-bar-inventory');
const {lockMaterialBarReceiptLotTx,prepareMaterialBarReceiptTx,applyMaterialBarReceiptTx}=load('material-bar-receipt');
const {planMaterialBarReservation,allocateMaterialBarReservationTx}=load('material-bar-holds');
const config=JSON.parse(fs.readFileSync(0,'utf8'));assert.equal(config.database,'material_bars_1246');
const tx=new Client(config);let passed=0;const pass=label=>{passed++;console.log(`PASS: ${label}`);};
async function setup(quantity=0){
 const article=id(),lot=id(),level=id(),batch=id();
 await tx.query("INSERT INTO public.articles VALUES($1,'BAR-RECEIPT','Received fixture bar','mm')",[article]);
 await tx.query("INSERT INTO public.lots VALUES($1,$2,'RECEIPT-FIXTURE')",[lot,article]);
 await tx.query('INSERT INTO public.stock_levels VALUES($1,$2)',[level,article]);
 await tx.query('INSERT INTO public.stock_batches VALUES($1,$2,$3,$4,0)',[batch,lot,level,quantity]);
 return {article,lot,batch};
}
async function draft(f,quantity,groups,required=true){
 await lockMaterialBarReceiptLotTx(tx,f.lot);const movement=id();
 await tx.query("INSERT INTO public.stock_movements(id,stock_batch_id,article_id,qty,status,movement_type) VALUES($1,$2,$3,$4,'DRAFT','IN')",[movement,f.batch,f.article,quantity]);
 return prepareMaterialBarReceiptTx(tx,{movementId:movement,required,groups});
}
async function post(plan){
 await tx.query("UPDATE public.stock_movements SET status='POSTED' WHERE id=$1",[plan.movementId]);
 await tx.query('UPDATE public.stock_batches SET qty_total=qty_total+$2 WHERE id=$1',[plan.current.batch.id,plan.quantityMm]);
 return applyMaterialBarReceiptTx(tx,plan,1246);
}
async function main(){
 await tx.connect();assert.equal((await tx.query('SELECT current_database() AS name')).rows[0].name,'material_bars_1246');
 const f=await setup();await tx.query('BEGIN');const first=await draft(f,6000,[{lengthMm:3000,count:2}]);await post(first);await tx.query('ROLLBACK');
 let current=await readMaterialBarInventoryTx(tx,f.batch);assert.equal(current.status,'UNCONFIRMED');assert.equal(current.batch.physicalMm,0);assert.equal(current.bars.length,0);
 assert.equal((await tx.query('SELECT count(*)::int AS n FROM public.stock_movements WHERE id=$1',[first.movementId])).rows[0].n,0);
 pass('rollback removes incoming stock, new bars and immutable receipt events together');
 await tx.query('BEGIN');const entry=await draft(f,6000,[{lengthMm:3000,count:2}]);current=await post(entry);await tx.query('COMMIT');
 assert.equal(current.status,'CONFIRMED');assert.deepEqual(current.bars.map(b=>b.lengthMm),[3000,3000]);assert.equal(current.batch.physicalMm,6000);
 const proof=(await tx.query("SELECT stock_movement_id::text AS movement FROM public.stock_material_bar_events WHERE command_key=$1 AND action='INITIALIZE'",[entry.movementId])).rows;
 assert.equal(proof.length,2);assert.ok(proof.every(p=>p.movement===entry.movementId));pass('two received 3 m bars become distinct identities tied to the posted IN');
 await tx.query('BEGIN');await assert.rejects(applyMaterialBarReceiptTx(tx,entry,1246),e=>e.code==='MATERIAL_BAR_RECEIPT_CHANGED');await tx.query('ROLLBACK');
 pass('applying the same receipt plan twice cannot duplicate bars');
 await tx.query('BEGIN');const r=id(),alloc=planMaterialBarReservation(current,221);
 await tx.query("INSERT INTO public.stock_reservations(id,stock_batch_id,qty_reserved,qty_consumed,status) VALUES($1,$2,221,0,'ACTIVE')",[r,f.batch]);
 await tx.query('UPDATE public.stock_batches SET qty_reserved=221 WHERE id=$1',[f.batch]);
 await allocateMaterialBarReservationTx(tx,current,alloc,{reservationId:r,actor:1246,commandKey:id(),reason:'Automatic receipt allocation fixture'});await tx.query('COMMIT');
 current=await readMaterialBarInventoryTx(tx,f.batch);assert.equal(current.status,'CONFIRMED');assert.equal(current.holds[0].remainingMm,221);
 pass('the incoming bar is immediately usable by the physical reservation repository');
 const old=current;await tx.query('BEGIN');const addition=await draft(f,2000,[{lengthMm:1000,count:2}]);current=await post(addition);await tx.query('COMMIT');
 assert.equal(current.status,'CONFIRMED');assert.equal(current.batch.physicalMm,8000);assert.equal(current.bars.length,4);
 assert.deepEqual(current.holds,old.holds);assert.deepEqual(current.bars.filter(b=>old.bars.some(o=>o.id===b.id)),old.bars);
 pass('partial receipts append new bars without changing old identities, versions or holds');
 await tx.query('BEGIN');await assert.rejects(draft(f,3000,[{lengthMm:2000,count:1}]),e=>e.code==='MATERIAL_BAR_RECEIPT_INVALID');await tx.query('ROLLBACK');
 assert.equal((await readMaterialBarInventoryTx(tx,f.batch)).batch.physicalMm,8000);pass('a receipt cannot override the canonical purchase conversion with different lengths');
 const unknown=await setup(1000);await tx.query('BEGIN');await assert.rejects(draft(unknown,3000,[{lengthMm:3000,count:1}]),e=>e.code==='MATERIAL_BAR_RECEIPT_EXISTING_STOCK');await tx.query('ROLLBACK');
 pass('old stock with unknown geometry is never certified by a new receipt');
 await tx.query('BEGIN');await assert.rejects(draft(f,3000,undefined,false),e=>e.code==='MATERIAL_BAR_RECEIPT_REQUIRED');await tx.query('ROLLBACK');
 pass('already tracked bars still require geometry if the article setting changes');
 await tx.query('BEGIN');await tx.query('UPDATE public.stock_batches SET qty_total=qty_total+1 WHERE id=$1',[f.batch]);
 await assert.rejects(draft(f,3000,[{lengthMm:3000,count:1}]),e=>e.code==='MATERIAL_BAR_RECEIPT_EXISTING_STOCK');await tx.query('ROLLBACK');
 pass('inconsistent existing stock stops posting instead of masking a prior discrepancy');
 const nonBar=await setup(100);await tx.query('BEGIN');assert.equal(await draft(nonBar,100,undefined,false),null);await tx.query('ROLLBACK');
 pass('untracked millimetre stock remains compatible when no bar receipt is required');
 console.log(`MATERIAL1246_RECEIPT_REPOSITORY_PASS: ${passed} real PostgreSQL receipt checks`);
}
main().catch(async error=>{try{await tx.query('ROLLBACK');}catch{}console.error(error);process.exitCode=1;}).finally(()=>tx.end());
