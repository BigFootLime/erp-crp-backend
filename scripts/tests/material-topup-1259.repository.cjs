/* Run only against an isolated restored Test fixture. No mock replaces the
 * confirmation repository, canonical stock writes, bar holds or PostgreSQL. */
const assert = require('node:assert/strict');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const root = process.env.MATERIAL_TOPUP_COMPILED_ROOT;
if (!root || !process.env.DATABASE_URL) throw new Error('Explicit isolated fixture configuration required');
const pool = require(path.join(root, 'config/database.js')).default;
const { getOfMaterial } = require(path.join(root, 'module/production/services/of-material.service.js'));
const { confirmOfMaterial } = require(path.join(root, 'module/production/repository/of-material-confirmation.repository.js'));
const { repoCreateStockReservation } = require(path.join(root, 'module/stock/repository/stock-reservation.repository.js'));
let passed = 0;
const pass = label => { passed++; console.log(`PASS: ${label}`); };
async function state(reservationId) {
  return (await pool.query(`SELECT r.id::text,r.qty_reserved::float8 AS reserved,
    r.qty_consumed::float8 AS consumed,b.qty_reserved::float8 AS batch_reserved,
    h.remaining_length_mm::float8 AS held,bar.public_number::text AS barcode,
    (SELECT count(*)::int FROM public.stock_reservations x WHERE x.material_need_id=r.material_need_id AND x.lot_id=r.lot_id AND x.status='ACTIVE') AS active_count,
    (SELECT count(*)::int FROM public.stock_material_bar_events e WHERE e.bar_id=bar.id) AS events,
    (SELECT count(*)::int FROM public.stock_movements m WHERE m.stock_batch_id=b.id) AS movements
    FROM public.stock_reservations r JOIN public.stock_batches b ON b.id=r.stock_batch_id
    JOIN public.stock_material_bar_reservations h ON h.reservation_id=r.id
    JOIN public.stock_material_bars bar ON bar.id=h.bar_id WHERE r.id=$1::uuid`, [reservationId])).rows[0];
}
async function main() {
  assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name, 'material_topup_1259');
  const source = (await pool.query(`SELECT r.id::text,r.created_by AS actor,r.material_need_id::text AS need_id,
    r.stock_batch_id::text AS batch_id,r.article_id::text,r.lot_id::text,
    e.magasin_id::text,e.id::int AS emplacement_id
    FROM public.stock_reservations r JOIN public.lots l ON l.id=r.lot_id
    JOIN public.emplacements e ON e.location_id=r.location_id
    WHERE r.of_id=95 AND l.lot_code='LOT-2026-001254' AND r.status='ACTIVE'`)).rows;
  assert.equal(source.length, 1, 'Exact fictive recipe source required');
  const current = await getOfMaterial(95), need = current.needs.find(n => n.id === source[0].need_id);
  assert(need && !need.blockers.length);
  const before = await state(source[0].id);
  assert.equal(before.reserved, 210); assert.equal(before.held, 210);
  const audit = {user_id:source[0].actor,ip:null,user_agent:'isolated recipe fixture',device_type:null,
    os:null,browser:null,path:'/isolated/material-topup1259',page_key:'production',client_session_id:null};
  const body = {expectedVersion:current.version,idempotencyKey:randomUUID(),
    selections:[{needKey:need.key,batchId:source[0].batch_id,quantity:11}],futureSelections:[]};
  const [result,concurrent] = await Promise.all([confirmOfMaterial(95,body,audit,true),confirmOfMaterial(95,body,audit,true)]);
  const after = await state(source[0].id);
  assert.equal(after.id,before.id); assert.equal(after.active_count,1);
  assert.equal(after.reserved,221); assert.equal(after.held,221);
  assert.equal(after.batch_reserved,before.batch_reserved+11);
  assert.equal(after.consumed,before.consumed); assert.equal(after.barcode,before.barcode);
  assert.equal(after.movements,before.movements); assert.equal(after.events,before.events+1);
  assert.equal(result.commands.length,0);
  pass('real confirmation extends 210 to 221 mm on the original reservation and bar, without purchase or stock movement');
  assert.deepEqual(concurrent.reservedIds,result.reservedIds);
  pass('simultaneous identical confirmations serialize and reserve the increment only once');
  assert.equal(result.coverage.needs.find(n=>n.id===need.id).missing,0);
  pass('the full 20-blank requirement becomes covered only after the physical top-up commits');
  const replay = await confirmOfMaterial(95,body,audit,true);
  assert.deepEqual(await state(source[0].id),after);
  assert.deepEqual(replay.reservedIds,result.reservedIds);
  pass('the same confirmation is replayed without another hold, event, reservation or stock increment');
  await assert.rejects(confirmOfMaterial(95,{...body,idempotencyKey:randomUUID()},audit,true),
    error=>error.code==='MATERIAL_COVERAGE_CHANGED');
  assert.deepEqual(await state(source[0].id),after);
  pass('an obsolete preview is rejected without altering the completed reservation');
  await assert.rejects(confirmOfMaterial(95,{...body,selections:[{...body.selections[0],quantity:10}]},audit,true),
    error=>error.code==='IDEMPOTENCY_KEY_REUSED');
  assert.deepEqual(await state(source[0].id),after);
  pass('a replay with a different quantity is rejected without changing stock or holds');
  const row=source[0],reserve={article_id:row.article_id,lot_id:row.lot_id,magasin_id:row.magasin_id,
    emplacement_id:row.emplacement_id,qty:1,source:{source_type:'OF',of_id:95},reason:'Isolated top-up guard fixture'};
  const other=(await pool.query('SELECT id FROM public.ordres_fabrication WHERE id<>95 ORDER BY id LIMIT 1')).rows[0];
  assert(other);
  await assert.rejects(repoCreateStockReservation({...reserve,source:{source_type:'OF',of_id:other.id}},audit,randomUUID(),undefined,row.need_id),
    error=>error.status===409);
  assert.deepEqual(await state(row.id),after);
  pass('another OF cannot increase a reservation belonging to the original material need');
  await pool.query("UPDATE public.stock_reservations SET expires_at=now()-interval '1 day' WHERE id=$1::uuid",[row.id]);
  await assert.rejects(repoCreateStockReservation(reserve,audit,randomUUID(),undefined,row.need_id),error=>error.status===409);
  assert.deepEqual(await state(row.id),after);
  pass('an expired reservation is not resurrected by a new top-up and its counters remain intact');
  console.log(`MATERIAL_TOPUP1259_POSTGRES_PASS: ${passed} complete PostgreSQL repository checks`);
}
main().catch(error=>{console.error({name:error.name,code:error.code,message:error.message});process.exitCode=1;})
  .finally(()=>pool.end());
