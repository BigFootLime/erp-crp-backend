const assert=require('node:assert/strict'),{Pool}=require('pg');
const {readFullyReservedCommandeCoverage}=require('../../../dist/module/commande-client/repository/commande-reserved-coverage.repository');
async function main(){
 const database=process.argv[2];assert.equal(database,'cerp_test');
 const pool=new Pool({connectionString:'postgresql://postgres@localhost/cerp_test?host=%2Fvar%2Frun%2Fpostgresql'}),tx=await pool.connect();
 try{
  await tx.query('BEGIN READ ONLY');await tx.query('SET LOCAL ROLE cerp_app');
  assert.equal((await tx.query('SELECT numero FROM commande_client WHERE id=109')).rows[0]?.numero,'CMD-2026-1213');
  const coverage=await readFullyReservedCommandeCoverage(tx,109,[{commande_ligne_id:205,article_id:'75575aed-58c2-4194-ad50-072762a32f1d',qty_ordered:12}]);
  assert.deepEqual([...coverage],[[205,{old_qty:0,new_qty:12}]]);
  console.log(JSON.stringify({at:new Date().toISOString(),marker:'STOCK_REPLAY_OWNED12_READONLY_PASS',database,
   role:'cerp_app',order:109,line:205,ownReserved:12,proposedProduction:0,liveDataChanged:false,transactionReadOnly:true,businessRecipePassed:false}));
 }finally{await tx.query('ROLLBACK');tx.release();await pool.end();}
}
main().catch(error=>{console.error(JSON.stringify({marker:'STOCK_REPLAY_OWNED12_READONLY_FAIL',code:error.code,message:error.message}));process.exitCode=1;});
