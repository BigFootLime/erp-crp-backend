/* Isolated PostgreSQL physical count tests; canonical ledger writes are simulated.
 * This does not replace complete ERP inventory-session route acceptance. */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{randomUUID:id}=require('node:crypto'),{Client}=require('pg');
const load=name=>require(path.join(process.env.MATERIAL_BAR_COMPILED_ROOT,`src/module/stock/repository/${name}.repository.js`));
const {readMaterialBarInventoryTx}=load('material-bar-inventory');
const {prepareMaterialBarCountEntryTx,recordMaterialBarCountTx,prepareMaterialBarCountSessionTx,applyMaterialBarCountTx,loadMaterialBarCountLinesTx,readMaterialBarCountsTx}=load('material-bar-count');
const {planMaterialBarReservation,allocateMaterialBarReservationTx}=load('material-bar-holds');
const config=JSON.parse(fs.readFileSync(0,'utf8'));assert.equal(config.database,'material_bars_1246');
const tx=new Client(config);let passed=0;const pass=label=>{passed++;console.log(`PASS: ${label}`);};
async function setup(qty=6000){
 const article=id(),lot=id(),level=id(),batch=id();await tx.query("INSERT INTO public.articles VALUES($1,'BAR-COUNT','Count fixture bar','mm')",[article]);await tx.query("INSERT INTO public.lots VALUES($1,$2,'COUNT-FIXTURE')",[lot,article]);
 await tx.query('INSERT INTO public.stock_levels VALUES($1,$2)',[level,article]);await tx.query('INSERT INTO public.stock_batches VALUES($1,$2,$3,$4,0)',[batch,lot,level,qty]);return {article,lot,batch};
}
async function session(f){
 const current=await readMaterialBarInventoryTx(tx,f.batch),sessionId=id(),snapshotId=id();
 await tx.query("INSERT INTO public.stock_inventory_sessions(id,status) VALUES($1,'OPEN')",[sessionId]);
 await tx.query('INSERT INTO public.stock_inventory_snapshot_lines VALUES($1,$2,$3,$4,$5,$6)',[snapshotId,sessionId,f.batch,f.article,f.lot,current.batch.physicalMm]);
 return {f,sessionId,snapshotId,theoreticalQty:current.batch.physicalMm};
}
async function count(s,bars,round=1){
 const current=await readMaterialBarInventoryTx(tx,s.f.batch),qty=bars.reduce((sum,b)=>sum+Math.round(b.lengthMm*1000),0)/1000;
 const line={snapshotId:s.snapshotId,batchId:s.f.batch,articleId:s.f.article,lotId:s.f.lot,theoreticalQty:s.theoreticalQty,countedQty:qty};
 const body={expectedVersion:current.version,idempotencyKey:id(),reason:'Comptage physique de recette',bars};
 await tx.query('BEGIN');const p=await prepareMaterialBarCountEntryTx(tx,{line,body});const event=id();
 await tx.query('INSERT INTO public.stock_inventory_count_events(id,session_id,snapshot_line_id,counted_qty,count_round) VALUES($1,$2,$3,$4,$5)',[event,s.sessionId,s.snapshotId,qty,round]);
 await recordMaterialBarCountTx(tx,event,p);await tx.query('COMMIT');return {event,body,line:{...line,countEventId:event}};
}
async function prepare(s,requiresSecond=false){return prepareMaterialBarCountSessionTx(tx,s.sessionId,await loadMaterialBarCountLinesTx(tx,s.sessionId),requiresSecond);}
async function ledger(s,quantity){
 if(quantity===0)return null;const movement=id();
 await tx.query("INSERT INTO public.stock_movements(id,stock_batch_id,article_id,qty,status,movement_type) VALUES($1,$2,$3,$4,'POSTED','ADJUSTMENT')",[movement,s.f.batch,s.f.article,quantity]);
 await tx.query('INSERT INTO public.stock_inventory_session_movements VALUES($1,$2,$3)',[s.sessionId,s.snapshotId,movement]);
 await tx.query('UPDATE public.stock_batches SET qty_total=qty_total+$2 WHERE id=$1',[s.f.batch,quantity]);return movement;
}
async function close(s,requiresSecond=false){
 await tx.query('BEGIN');const lines=await loadMaterialBarCountLinesTx(tx,s.sessionId),p=await prepare(s,requiresSecond);assert.equal(p.size,1);
 const movement=await ledger(s,(Math.round(lines[0].countedQty*1000)-Math.round(s.theoreticalQty*1000))/1000);
 const current=await applyMaterialBarCountTx(tx,p.get(s.snapshotId),movement,1246);await tx.query("UPDATE public.stock_inventory_sessions SET status='CLOSED' WHERE id=$1",[s.sessionId]);await tx.query('COMMIT');return current;
}
const measured=current=>current.bars.filter(b=>b.lengthMm>0).map(b=>({id:b.id,lengthMm:b.lengthMm,allocations:current.holds.filter(h=>h.barId===b.id).map(h=>({reservationId:h.reservationId,quantityMm:h.remainingMm}))}));
async function main(){
 await tx.connect();assert.equal((await tx.query('SELECT current_database() AS name')).rows[0].name,'material_bars_1246');
 const f=await setup();let s=await session(f),barA=id(),barB=id();let c=await count(s,[{id:barA,lengthMm:3000,allocations:[]},{id:barB,lengthMm:3000,allocations:[]}]);
 assert.equal((await readMaterialBarInventoryTx(tx,f.batch)).bars.length,0);pass('saving a measured count does not modify stock or bar identities');
 let current=await close(s);assert.equal(current.status,'CONFIRMED');assert.equal(current.bars.length,2);assert.equal(current.batch.movementCount,'0');pass('first voluntary physical count initializes bars even without a bar-required article flag');
 assert.deepEqual((await readMaterialBarCountsTx(tx,[c.event])).get(c.event),c.body);pass('inventory read model returns the immutable measured bar detail');
 await tx.query('BEGIN');await assert.rejects(tx.query("UPDATE public.stock_inventory_material_bar_counts SET geometry_changed=false WHERE count_event_id=$1",[c.event]),e=>e.code==='23514');await tx.query('ROLLBACK');pass('a recorded physical count cannot be rewritten');
 s=await session(f);let bars=measured(current);bars.find(b=>b.id===barA).lengthMm=2500;await count(s,bars);current=await close(s);
 assert.equal(current.batch.physicalMm,5500);assert.equal(current.bars.find(b=>b.id===barA).lengthMm,2500);assert.equal(current.bars.length,2);pass('short count posts exactly its negative adjustment and retains existing barcodes');
 s=await session(f);bars=measured(current);bars.push({id:id(),lengthMm:1000,allocations:[]});await count(s,bars);current=await close(s);assert.equal(current.batch.physicalMm,6500);assert.equal(current.bars.length,3);pass('extra measured bar and positive adjustment are applied together');
 s=await session(f);bars=measured(current);bars.find(b=>b.id===barB).lengthMm=2500;bars.push({id:id(),lengthMm:500,allocations:[]});await count(s,bars);
 await tx.query('BEGIN');await assert.rejects(prepare(s,true),e=>e.code==='INVENTORY_SECOND_COUNTS_INCOMPLETE');await tx.query('ROLLBACK');pass('equal-total geometry change still requires the configured second count');
 await count(s,bars,2);const countBefore=current.batch.movementCount;current=await close(s,true);assert.equal(current.batch.physicalMm,6500);assert.equal(current.bars.length,4);assert.equal(current.batch.movementCount,countBefore);pass('second equal-total count updates geometry without inventing an adjustment movement');
 // A count can explicitly redistribute holds but may not drop a reservation.
 const reservation=id();await tx.query('BEGIN');const allocation=planMaterialBarReservation(current,1000);await tx.query("INSERT INTO public.stock_reservations(id,stock_batch_id,qty_reserved,qty_consumed,status) VALUES($1,$2,1000,0,'ACTIVE')",[reservation,f.batch]);await tx.query('UPDATE public.stock_batches SET qty_reserved=1000 WHERE id=$1',[f.batch]);await allocateMaterialBarReservationTx(tx,current,allocation,{reservationId:reservation,actor:1246,commandKey:id(),reason:'Count fixture allocation'});await tx.query('COMMIT');current=await readMaterialBarInventoryTx(tx,f.batch);
 s=await session(f);bars=measured(current);const held=bars.find(b=>b.allocations.length),target=bars.find(b=>b.id!==held.id&&b.lengthMm>=1000);held.allocations=[];target.allocations=[{reservationId:reservation,quantityMm:1000}];await count(s,bars);current=await close(s);assert.equal(current.holds.find(h=>h.reservationId===reservation).barId,target.id);assert.equal(current.batch.reservedMm,1000);pass('count explicitly reallocates the exact OF hold while preserving reserved quantity');
 s=await session(f);const beforeInvalid=current.version;await assert.rejects(count(s,measured(current).map(b=>({...b,allocations:[]}))));await tx.query('ROLLBACK');assert.equal((await readMaterialBarInventoryTx(tx,f.batch)).version,beforeInvalid);pass('missing reservation allocation rejects the count without modifying stock');
 s=await session(f);c=await count(s,measured(current));
 // An external remeasurement with the same total changes the bar version.
 await tx.query('UPDATE public.stock_material_bars SET row_version=row_version+1 WHERE id=$1',[barA]);
 await tx.query('BEGIN');await assert.rejects(prepare(s),e=>e.code==='MATERIAL_BAR_INVENTORY_CHANGED');await tx.query('ROLLBACK');pass('same-total later remeasurement makes an earlier count stale');
 current=await readMaterialBarInventoryTx(tx,f.batch);s=await session(f);bars=measured(current);bars.find(b=>b.id===barA).lengthMm-=1;await count(s,bars);
 await tx.query('BEGIN');let tokens=await prepare(s);const wrong=await ledger(s,-2);await assert.rejects(applyMaterialBarCountTx(tx,tokens.get(s.snapshotId),wrong,1246),e=>e.code==='MATERIAL_BAR_COUNT_CHANGED');await tx.query('ROLLBACK');assert.equal((await readMaterialBarInventoryTx(tx,f.batch)).version,current.version);pass('wrong canonical adjustment rolls back ledger and bars together');
 await tx.query('BEGIN');tokens=await prepare(s);const correct=await ledger(s,-1);await assert.rejects(applyMaterialBarCountTx({query:tx.query.bind(tx)},tokens.get(s.snapshotId),correct,1246),e=>e.code==='MATERIAL_BAR_COUNT_CHANGED');await tx.query('ROLLBACK');pass('prepared count cannot be applied through another transaction client');
 current=await close(s);assert.equal(current.status,'CONFIRMED');
 const foreign=await setup(500);let foreignSession=await session(foreign);const foreignId=id();await count(foreignSession,[{id:foreignId,lengthMm:500,allocations:[]}]);await close(foreignSession);
 s=await session(f);bars=measured(current);bars.push({id:foreignId,lengthMm:500,allocations:[]});await assert.rejects(count(s,bars),e=>e.code==='MATERIAL_BAR_IDENTITY_USED');await tx.query('ROLLBACK');pass('a barcode belonging to another batch is rejected while entering the count');
 s=await session(f);const missing=id();await tx.query('INSERT INTO public.stock_inventory_count_events(id,session_id,snapshot_line_id,counted_qty,count_round) VALUES($1,$2,$3,$4,1)',[missing,s.sessionId,s.snapshotId,current.batch.physicalMm]);
 await tx.query('BEGIN');await assert.rejects(prepare(s),e=>e.code==='MATERIAL_BAR_COUNT_REQUIRED');await tx.query('ROLLBACK');pass('legacy aggregate count cannot silently close tracked bar stock');
 await tx.query('BEGIN');await assert.rejects(tx.query('INSERT INTO public.stock_inventory_material_bar_counts(count_event_id,stock_batch_id,geometry_changed,measurement) VALUES($1,$2,true,$3::jsonb)',[missing,foreign.batch,JSON.stringify({expectedVersion:current.version,bars:measured(current)})]),e=>e.code==='23514');await tx.query('ROLLBACK');pass('SQL rejects physical evidence attached to the wrong count batch');
 await tx.query('BEGIN');await assert.rejects(tx.query('INSERT INTO public.stock_inventory_material_bar_counts(count_event_id,stock_batch_id,geometry_changed,measurement) VALUES($1,$2,true,$3::jsonb)',[missing,f.batch,JSON.stringify({expectedVersion:current.version,bars:[]})]),e=>e.code==='23514');await tx.query('ROLLBACK');pass('SQL rejects a physical measured total different from its canonical count');
 await tx.query("UPDATE public.stock_inventory_sessions SET status='CLOSED' WHERE id=$1",[s.sessionId]);
 await tx.query('BEGIN');await assert.rejects(tx.query('INSERT INTO public.stock_inventory_material_bar_counts(count_event_id,stock_batch_id,geometry_changed,measurement) VALUES($1,$2,true,$3::jsonb)',[missing,f.batch,JSON.stringify({expectedVersion:current.version,bars:measured(current)})]),e=>e.code==='23514');await tx.query('ROLLBACK');pass('SQL refuses attaching new physical evidence after inventory closure');
 const rollback=fs.readFileSync(path.join(__dirname,'20261012_physical_material_bar_counts_1246.rollback.sql'),'utf8');
 await assert.rejects(tx.query(rollback),e=>e.code==='P0001'&&e.message.includes('Physical count evidence exists'));await tx.query('ROLLBACK');
 assert.ok(Number((await tx.query('SELECT count(*) FROM public.stock_inventory_material_bar_counts')).rows[0].count)>0);pass('rollback refuses to erase recorded physical counts');
 console.log(`MATERIAL1246_COUNT_REPOSITORY_PASS: ${passed} real PostgreSQL adapter checks`);
}
main().catch(async error=>{try{await tx.query('ROLLBACK');}catch{}console.error(error);process.exitCode=1;}).finally(()=>tx.end());
