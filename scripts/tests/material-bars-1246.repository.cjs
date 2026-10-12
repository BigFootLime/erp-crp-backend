/* Run only against the disposable SQL fixture, with pg available in NODE_PATH.
 * JSON connection settings arrive on stdin and are never printed. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {Client}=require('pg');
const root=process.env.MATERIAL_BAR_COMPILED_ROOT;
if(!root)throw Error('MATERIAL_BAR_COMPILED_ROOT is required');
const {assertMaterialBarSchema,readMaterialBarInventoryTx,lockMaterialBarInventoryTx,writeMaterialBarInventoryTx}=require(path.join(root,'src/module/stock/repository/material-bar-inventory.repository.js'));
const {readTrackedMaterialBarInventoryTx,planMaterialBarReservation,allocateMaterialBarReservationTx,releaseMaterialBarReservationTx,reservationHasPhysicalBarsTx}=require(path.join(root,'src/module/stock/repository/material-bar-holds.repository.js'));
const cfg=JSON.parse(fs.readFileSync(0,'utf8'));
assert.equal(cfg.database,'material_bars_1246');
const tx=new Client(cfg),other=new Client({...cfg,application_name:'material1246-race'}),id=()=>crypto.randomUUID();
const article=id(),lot=id(),level=id(),batch=id(),reservationA=id(),reservationB=id(),barA=id(),barB=id(),barB2=id();
let passed=0;
function pass(name){passed++;console.log(`PASS: ${name}`);}
const body=(version,a=2000,b=1000,bId=barB)=>({expectedVersion:version,idempotencyKey:id(),reason:'Measured fixture bars',bars:[
  {id:barA,lengthMm:a,allocations:[{reservationId:reservationA,quantityMm:200}]},
  {id:bId,lengthMm:b,allocations:[{reservationId:reservationB,quantityMm:100}]}]});
async function command(input){
  await tx.query('BEGIN');
  try{const current=await lockMaterialBarInventoryTx(tx,batch);const result=await writeMaterialBarInventoryTx(tx,current,input,1246,id());await tx.query('COMMIT');return result;}
  catch(error){await tx.query('ROLLBACK');throw error;}
}
async function main(){
  await tx.connect();await other.connect();
  const otherPid=(await other.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  assert.equal((await tx.query('SELECT current_database() AS name')).rows[0].name,'material_bars_1246');
  await assertMaterialBarSchema(tx);
  await tx.query('INSERT INTO public.users VALUES(1246) ON CONFLICT DO NOTHING');
  await tx.query("INSERT INTO public.articles VALUES($1,'FIXTURE-MP','Fixture bar','mm')",[article]);
  await tx.query("INSERT INTO public.lots VALUES($1,$2,'FIXTURE-LOT')",[lot,article]);
  await tx.query('INSERT INTO public.stock_levels VALUES($1,$2)',[level,article]);
  await tx.query('INSERT INTO public.stock_batches VALUES($1,$2,$3,3000,300)',[batch,lot,level]);
  await tx.query("INSERT INTO public.stock_reservations(id,stock_batch_id,qty_reserved,qty_consumed,status) VALUES($1,$3,200,0,'ACTIVE'),($2,$3,100,0,'ACTIVE')",[reservationA,reservationB,batch]);
  let current=await readMaterialBarInventoryTx(tx,batch);assert.equal(current.status,'UNCONFIRMED');assert.equal(current.bars.length,0);pass('aggregate stock never creates inferred bars');
  await assert.rejects(command(body(current.version,2000,999)),/Confirmez les barres/);assert.equal((await tx.query('SELECT count(*)::int AS n FROM public.stock_material_bars WHERE stock_batch_id=$1',[batch])).rows[0].n,0);pass('wrong geometry fails atomically');
  current=await command(body(current.version));assert.equal(current.status,'CONFIRMED');assert.equal(current.bars.length,2);assert.equal(current.holds.length,2);assert.equal(current.batch.physicalMm,3000);assert.equal(current.batch.reservedMm,300);pass('physical inventory preserves canonical balances and allocations');
  const originalVersion=current.version;
  await assert.rejects(command(body(current.version,1900,1100)),/nouvelle identité/);pass('an existing bar cannot silently grow beyond its original length');
  current=await command(body(current.version,1900,1100,barB2));assert.equal(current.status,'CONFIRMED');assert.equal(current.bars.some(b=>b.id===barB),false);assert.equal((await tx.query('SELECT retired_at IS NOT NULL AS retired FROM public.stock_material_bars WHERE id=$1',[barB])).rows[0].retired,true);assert.equal(current.holds.find(h=>h.reservationId===reservationB).barId,barB2);pass('reconciliation preserves retired identity and moves each hold explicitly');
  await assert.rejects(command(body(current.version,2000,1000,barB)),/déjà utilisée/);pass('retired bar identities cannot be reused');
  await assert.rejects(command(body(originalVersion)),/ont changé/);pass('stale inventory versions are rejected');
  // Two posted movements with unchanged net quantity still invalidate geometry.
  await tx.query("INSERT INTO public.stock_movements VALUES($1,$3,'POSTED'),($2,$3,'POSTED')",[id(),id(),batch]);
  const outdated=await readMaterialBarInventoryTx(tx,batch);assert.equal(outdated.status,'REVIEW_REQUIRED');assert.match(outdated.warning,/mouvement/);pass('net-zero untracked movements invalidate geometry');
  await assert.rejects(command(body(current.version,1900,1100,barB2)),/ont changé/);
  current=await command(body(outdated.version,1900,1100,barB2));assert.equal(current.status,'CONFIRMED');assert.equal(current.batch.movementCount,'2');pass('explicit remeasurement reconciles freshness without changing stock');
  // Same-batch writers must wait, then reject the obsolete preview.
  const beforeRace=current.version;
  await tx.query('BEGIN');await other.query('BEGIN');
  await lockMaterialBarInventoryTx(tx,batch);
  let acquired=false;
  const waiting=lockMaterialBarInventoryTx(other,batch).then(value=>{acquired=true;return value;});
  let lockObserved=false;
  for(let tries=0;tries<50;tries++){
    lockObserved=(await tx.query('SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND NOT granted) AS waiting',[otherPid])).rows[0].waiting;
    if(lockObserved)break;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.equal(lockObserved,true);assert.equal(acquired,false);
  await writeMaterialBarInventoryTx(tx,await readMaterialBarInventoryTx(tx,batch),body(beforeRace,1900,1100,barB2),1246,id());
  await tx.query('COMMIT');
  const second=await waiting;
  await assert.rejects(writeMaterialBarInventoryTx(other,second,body(beforeRace,1900,1100,barB2),1246,id()),/ont changé/);
  await other.query('ROLLBACK');pass('concurrent confirmations serialize and reject a stale overwrite');
  current=await readMaterialBarInventoryTx(tx,batch);assert.equal(current.status,'CONFIRMED');assert.equal(current.batch.reservedMm,300);assert.equal(current.holds.reduce((n,h)=>n+h.remainingMm,0),300);pass('concurrent failure preserves all reservation lengths');
  // Exercise the same helper sequence used by the canonical reservation command.
  await tx.query('BEGIN');await lockMaterialBarInventoryTx(tx,batch);
  current=await readTrackedMaterialBarInventoryTx(tx,batch);
  const reserveId=id(),plan=planMaterialBarReservation(current,2100);
  assert.equal(plan.length,2);assert.deepEqual(plan.map(a=>a.quantityMm),[1700,400]);
  await tx.query('UPDATE public.stock_batches SET qty_reserved=qty_reserved+2100 WHERE id=$1',[batch]);
  await tx.query("INSERT INTO public.stock_reservations(id,stock_batch_id,qty_reserved,qty_consumed,status) VALUES($1,$2,2100,0,'ACTIVE')",[reserveId,batch]);
  await allocateMaterialBarReservationTx(tx,current,plan,{reservationId:reserveId,actor:1246,commandKey:id(),reason:'Fixture physical reservation'});
  await tx.query('COMMIT');
  current=await readMaterialBarInventoryTx(tx,batch);assert.equal(current.status,'CONFIRMED');assert.equal(current.batch.reservedMm,2400);assert.equal(await reservationHasPhysicalBarsTx(tx,reserveId),true);pass('reservation assigns exact lengths to two physical bars atomically');
  assert.throws(()=>planMaterialBarReservation(current,601),/exactement/);pass('other OF reservations cannot be borrowed by an oversized request');
  await tx.query('BEGIN');await lockMaterialBarInventoryTx(tx,batch);
  await tx.query("UPDATE public.stock_reservations SET status='RELEASED',row_version=row_version+1 WHERE id=$1",[reserveId]);
  await tx.query('UPDATE public.stock_batches SET qty_reserved=qty_reserved-2100 WHERE id=$1',[batch]);
  await releaseMaterialBarReservationTx(tx,{reservationId:reserveId,actor:1246,commandKey:id(),reason:'Fixture cancellation'});
  await tx.query('COMMIT');
  current=await readMaterialBarInventoryTx(tx,batch);assert.equal(current.status,'CONFIRMED');assert.equal(current.batch.reservedMm,300);assert.deepEqual(current.bars.map(b=>b.lengthMm),[1900,1100]);assert.equal(await reservationHasPhysicalBarsTx(tx,reserveId),false);pass('release frees allocations while preserving bars and other OF holds');
  const old=current,stalePlan=planMaterialBarReservation(current,100),failedId=id();
  await command(body(current.version,1900,1100,barB2));
  await tx.query('BEGIN');
  await tx.query('UPDATE public.stock_batches SET qty_reserved=qty_reserved+100 WHERE id=$1',[batch]);
  await tx.query("INSERT INTO public.stock_reservations(id,stock_batch_id,qty_reserved,qty_consumed,status) VALUES($1,$2,100,0,'ACTIVE')",[failedId,batch]);
  await assert.rejects(allocateMaterialBarReservationTx(tx,old,stalePlan,{reservationId:failedId,actor:1246,commandKey:id(),reason:'Obsolete selection'}),/a changé/);
  await tx.query('ROLLBACK');
  current=await readMaterialBarInventoryTx(tx,batch);assert.equal(current.status,'CONFIRMED');assert.equal(current.batch.reservedMm,300);assert.equal((await tx.query('SELECT id FROM public.stock_reservations WHERE id=$1',[failedId])).rows.length,0);pass('stale bar write rolls back canonical reservation and counters');
  console.log(`MATERIAL1246_REPOSITORY_PASS: ${passed} real PostgreSQL repository checks`);
}
main().catch(error=>{console.error(error.name+': '+error.message);process.exitCode=1;}).finally(async()=>{await Promise.allSettled([tx.end(),other.end()]);});
