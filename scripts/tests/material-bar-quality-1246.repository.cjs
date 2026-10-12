/* Real physical repositories; canonical ledger writes are simulated in an
 * isolated fixture database. Full ERP/HTTP quality acceptance remains separate. */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{randomUUID:id}=require('node:crypto'),{Client}=require('pg');
const load=n=>require(path.join(process.env.MATERIAL_BAR_COMPILED_ROOT,`src/module/stock/repository/${n}.repository.js`));
const {readMaterialBarInventoryTx,writeMaterialBarInventoryTx}=load('material-bar-inventory');
const {lockMaterialBarPostingScopeTx,prepareMaterialBarPostingTx,applyMaterialBarPostingTx}=load('material-bar-posting');
const {planMaterialBarReservation}=load('material-bar-holds');
const config=JSON.parse(fs.readFileSync(0,'utf8'));assert.equal(config.database,'material_bars_1246');const tx=new Client(config);
let passed=0;const pass=label=>{passed++;console.log(`PASS: ${label}`);};
async function setup(){
 const article=id(),lot=id(),level=id(),batch=id();await tx.query('BEGIN');
 await tx.query("INSERT INTO public.articles VALUES($1,'BAR-QUALITY','Quality fixture bar','mm')",[article]);await tx.query("INSERT INTO public.lots VALUES($1,$2,'QUALITY-FIXTURE')",[lot,article]);
 await tx.query('INSERT INTO public.stock_levels VALUES($1,$2)',[level,article]);await tx.query('INSERT INTO public.stock_batches(id,lot_id,stock_level_id,qty_total,qty_reserved) VALUES($1,$2,$3,6000,0)',[batch,lot,level]);
 const s=await readMaterialBarInventoryTx(tx,batch);await writeMaterialBarInventoryTx(tx,s,{expectedVersion:s.version,idempotencyKey:id(),reason:'Barres de recette qualité',bars:[{id:id(),lengthMm:3000,allocations:[]},{id:id(),lengthMm:3000,allocations:[]}]},1246,id());
 await tx.query('COMMIT');return {article,lot,batch};
}
async function prepare(f,quantity=1000,type='SCRAP',barIndex=0){
 const source=await readMaterialBarInventoryTx(tx,f.batch),movement=id();
 await tx.query('INSERT INTO public.stock_movements(id,stock_batch_id,article_id,qty,status,movement_type) VALUES($1,$2,$3,$4,\'DRAFT\',$5)',[movement,f.batch,f.article,quantity,type]);
 const scope=await lockMaterialBarPostingScopeTx(tx,{articleId:f.article,lotIds:[f.lot],explicit:true});
 const command={kind:'DEPRECIATE',expectedVersion:source.version,bars:[{barId:source.bars[barIndex].id,expectedVersion:source.bars[barIndex].version,quantityMm:quantity}]};
 const token=await prepareMaterialBarPostingTx(tx,{scope,movement:{id:movement,batchId:f.batch,type,quantity,reversalOf:null},command,externalTransaction:false});
 return {source,movement,token,quantity};
}
async function post(f,p,quantity=p.quantity){await tx.query("UPDATE public.stock_movements SET status='POSTED' WHERE id=$1",[p.movement]);await tx.query('UPDATE public.stock_batches SET qty_depreciated=qty_depreciated+$2 WHERE id=$1',[f.batch,quantity]);}
async function fails(work,pattern){await assert.rejects(work,pattern);await tx.query('ROLLBACK');}
(async()=>{await tx.connect();
 const f=await setup();await tx.query('BEGIN');const p=await prepare(f,3000);await post(f,p);await applyMaterialBarPostingTx(tx,p.token,1246);await tx.query('COMMIT');
 let s=await readMaterialBarInventoryTx(tx,f.batch);assert.equal(s.status,'CONFIRMED');assert.equal(s.batch.physicalMm,6000);assert.equal(s.batch.depreciatedMm,3000);assert.equal(s.bars[0].lengthMm,3000);assert.equal(s.bars[0].depreciatedMm,3000);pass('scrap preserves physical length and affects only the selected bar');
 assert.deepEqual(planMaterialBarReservation(s,3000).map(a=>a.barId),[s.bars[1].id]);assert.throws(()=>planMaterialBarReservation(s,1,[{barId:s.bars[0].id,quantityMm:1,expectedVersion:s.bars[0].version}]));pass('automatic and explicit reservations exclude rejected capacity');
 await assert.rejects(()=>applyMaterialBarPostingTx(tx,p.token,1246));pass('quality capability cannot be replayed');
 assert.equal((await tx.query("SELECT count(*)::int AS n FROM public.stock_material_bar_events WHERE stock_movement_id=$1 AND action='DEPRECIATE'",[p.movement])).rows[0].n,1);pass('immutable quality proof points to its canonical movement');
 await tx.query('BEGIN');await fails(async()=>{await tx.query('UPDATE public.stock_batches SET qty_depreciated=qty_depreciated+1 WHERE id=$1',[f.batch]);await tx.query('COMMIT');},{constraint:'stock_material_quality_complete_1246'});pass('canonical depreciation cannot bypass physical allocation');
 await tx.query('BEGIN');await fails(async()=>{await tx.query('UPDATE public.stock_material_bars SET depreciated_length_mm=2999 WHERE id=$1',[s.bars[0].id]);await tx.query('COMMIT');},{constraint:'stock_material_quality_complete_1246'});pass('physical quality cannot bypass canonical depreciation');
 await tx.query('BEGIN');await fails(async()=>{await writeMaterialBarInventoryTx(tx,s,{expectedVersion:s.version,idempotencyKey:id(),reason:'Count cannot erase quality',bars:s.bars.map(b=>({id:b.id,lengthMm:b.lengthMm,allocations:[]}))},1246,id());},/Affectez/);pass('recount cannot silently clear a quality decision');
 await tx.query('BEGIN');const mismatch=await prepare(f,1000,'DEPRECIATE',1);await post(f,mismatch,999);await fails(()=>applyMaterialBarPostingTx(tx,mismatch.token,1246),/stock|réservations/);assert.equal((await readMaterialBarInventoryTx(tx,f.batch)).batch.depreciatedMm,3000);pass('incorrect ledger delta rolls the whole quality change back');
 await tx.query('BEGIN');const crossed=await prepare(f,1000,'DEPRECIATE',1);await fails(()=>applyMaterialBarPostingTx({query:tx.query.bind(tx)},crossed.token,1246),/transaction/);pass('quality capability is transaction bound');
 await tx.query('BEGIN');await fails(()=>prepare(f,1,'SCRAP',0),/dépréciée|libre/);pass('already rejected length cannot be depreciated twice');
 await tx.query('BEGIN');await fails(()=>prepare(f,1,'OUT',1),/décision qualité/);pass('quality payload cannot turn a physical OUT into depreciation');
 await tx.query('BEGIN');const second=await prepare(f,1000,'DEPRECIATE',1);await post(f,second);await applyMaterialBarPostingTx(tx,second.token,1246);await tx.query('COMMIT');
 s=await readMaterialBarInventoryTx(tx,f.batch);assert.equal(s.batch.depreciatedMm,4000);assert.equal(s.batch.physicalMm,6000);pass('successive decisions accumulate depreciation without shrinking physical bars');
 await tx.query('BEGIN');await fails(async()=>{const reservation=id();await tx.query("INSERT INTO public.stock_reservations(id,stock_batch_id,qty_reserved,qty_consumed,status) VALUES($1,$2,2001,0,'ACTIVE')",[reservation,f.batch]);
 await tx.query('UPDATE public.stock_batches SET qty_reserved=2001 WHERE id=$1',[f.batch]);await tx.query('INSERT INTO public.stock_material_bar_reservations(bar_id,reservation_id,remaining_length_mm,updated_by) VALUES($1,$2,2001,1246)',[s.bars[1].id,reservation]);await tx.query('COMMIT');},{constraint:'stock_material_quality_complete_1246'});pass('SQL prevents a reservation from overlapping depreciated bar capacity');
 await tx.query('BEGIN');await fails(async()=>{await tx.query("UPDATE public.stock_material_bar_events SET reason='changed' WHERE stock_movement_id=$1",[p.movement]);},/immutable|immutable|Physical bar/i);pass('quality evidence is immutable');
 await fails(()=>tx.query(fs.readFileSync(path.join(__dirname,'20261012_physical_material_bar_quality_1246.rollback.sql'),'utf8')),/Physical quality evidence exists/);pass('rollback preserves used quality evidence');
 console.log(`MATERIAL1246_QUALITY_REPOSITORY_PASS: ${passed}`);
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>tx.end());
