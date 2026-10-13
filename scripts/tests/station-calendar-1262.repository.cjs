/* Read-only PostgreSQL check of the exact worklist projection. No mutation. */
const assert=require('node:assert/strict'),path=require('node:path');
const root=process.env.STATION_CALENDAR_COMPILED_ROOT;
if(!root)throw new Error('Explicit compiled source required');
const pool=require(path.join(root,'config/database.js')).default;
const {repoWorklist}=require(path.join(root,'module/production/repository/station.repository.js'));
async function main(){
  const settings=(await pool.query("SELECT current_database() AS name,current_setting('default_transaction_read_only') AS readonly")).rows[0];
  assert.equal(settings.name,'cerp_test');assert.equal(settings.readonly,'on');
  const original=(await pool.query("SELECT to_char(date_fin_prevue,'YYYY-MM-DD') AS deadline FROM public.ordres_fabrication WHERE id=95 AND numero='OF-2026-001238'")).rows[0];
  assert.equal(original.deadline,'2026-10-16');
  const rows=await repoWorklist({machineId:null,workshopZone:null,q:'OF-2026-001238',machineOnly:false,materialOnly:false,includeBlocked:true,limit:50});
  assert(rows.length>0);assert(rows.every(row=>row.of_id===95&&row.date_fin_prevue===original.deadline));
  console.log('PASS: actual Test worklist preserves 2026-10-16 for every returned operation of the fictive OF95');
  const dates=(await pool.query("SELECT to_char(d,'YYYY-MM-DD') AS value FROM (VALUES(DATE '2024-02-29'),(DATE '2026-12-31'),(DATE '2027-01-01'),(NULL::date)) dates(d)")).rows;
  assert.deepEqual(dates.map(row=>row.value),['2024-02-29','2026-12-31','2027-01-01',null]);
  console.log('PASS: real PostgreSQL calendar projection preserves leap day, year boundaries and null');
  const after=(await pool.query("SELECT to_char(date_fin_prevue,'YYYY-MM-DD') AS deadline FROM public.ordres_fabrication WHERE id=95")).rows[0];
  assert.deepEqual(after,original);
  console.log('STATION_CALENDAR1262_READONLY_POSTGRES_PASS: 2; database values unchanged');
}
main().catch(error=>{console.error({name:error.name,code:error.code,message:error.message});process.exitCode=1;}).finally(()=>pool.end());
