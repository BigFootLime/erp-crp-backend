const assert=require('node:assert/strict'),{Pool}=require('pg');
const {stockLotTraceReferenceValuesSql}=require('../../../dist/shared/provenance/stock-lot-trace.sql');
async function main(){
 assert.equal(process.argv[2],'cerp_test');
 const pool=new Pool({connectionString:'postgresql://postgres@localhost/cerp_test?host=%2Fvar%2Frun%2Fpostgresql'}),tx=await pool.connect();
 try{
  await tx.query('BEGIN READ ONLY');await tx.query('SET LOCAL ROLE cerp_app');
  const data=(await tx.query(`SELECT ARRAY(SELECT DISTINCT reference_value FROM (${stockLotTraceReferenceValuesSql('lot.id','MP_LOT')}) mp ORDER BY reference_value) AS mp,
   ARRAY(SELECT DISTINCT reference_value FROM (${stockLotTraceReferenceValuesSql('lot.id','TRAITEMENT_LOT')}) tr ORDER BY reference_value) AS tr
   FROM public.lots lot WHERE lot.id=$1::uuid`,['67e7c48d-daa4-4eb8-b8d1-e136a45ea461'])).rows[0];
  assert.deepEqual(data.mp,['LOT-2026-001253','LOT-2026-001254']);
  const expected=(await tx.query('SELECT lot_code FROM public.lots WHERE id=ANY($1::uuid[]) ORDER BY lot_code',[
    ['f3a54107-2e0f-4559-a3d8-5c1c2d61fb32','5a116ea8-297c-4017-989b-e7e679184f0c']])).rows.map(row=>row.lot_code);
  assert.equal(expected.length,2);assert.deepEqual(data.tr,expected);
  console.log(JSON.stringify({at:new Date().toISOString(),marker:'STOCK_LOT1310_TRACE_READONLY_PASS',database:'cerp_test',role:'cerp_app',
   lot:'LOT-2026-001310',mp:data.mp,tr:data.tr,source:'posted non-compensated cuts and immutable completed treatment returns',
   liveDataChanged:false,physicalVerificationPerformed:false,businessRecipePassed:false}));
 }finally{await tx.query('ROLLBACK');tx.release();await pool.end();}
}
main().catch(error=>{console.error(JSON.stringify({marker:'STOCK_LOT1310_TRACE_READONLY_FAIL',code:error.code,message:error.message}));process.exitCode=1;});
