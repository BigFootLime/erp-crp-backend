/** Run with the test host environment; credentials are never logged or copied.
 * Bundle with esbuild --platform=node --format=cjs --packages=external. */
async function main(){
  if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL environment required');
  const url=new URL(process.env.DATABASE_URL);url.pathname='/cerp_test';process.env.DATABASE_URL=url.toString();
  process.env.PGOPTIONS='-c default_transaction_read_only=on';
  const pool=require('../../src/config/database').default;
  const tx=await pool.connect();
  try{
    await tx.query('BEGIN READ ONLY');
    const database=(await tx.query('SELECT current_database() AS name,current_user AS role')).rows[0];
    if(database.name!=='cerp_test'||database.role!=='cerp_app')throw new Error('Unexpected database or role');
    const expected=await require('../../src/module/receptions/repository/expected-receipts.repository').readExpectedReceiptLinesTx(tx,{page:1,pageSize:10});
    const of=(await tx.query('SELECT id FROM public.ordres_fabrication ORDER BY id DESC LIMIT 1')).rows[0];
    if(of)await require('../../src/module/production/repository/consumable-procurement-read.repository').readOfConsumablesTx(tx,Number(of.id));
    const articles=(await tx.query('SELECT article_id::text AS id FROM public.stock_levels WHERE qty_total>0 LIMIT 3')).rows;
    const stock=await require('../../src/module/stock/repository/consumable-stock.repository').readConsumableStockTx(tx,articles.map((a:{id:string})=>a.id));
    await tx.query('ROLLBACK');
    console.log(JSON.stringify({database:database.name,role:database.role,expectedLines:expected.items.length,ofRead:!!of,stockCandidates:stock.length,result:'PASS'}));
  }finally{tx.release();await pool.end();}
}
main().catch(e=>{console.error(JSON.stringify({result:'FAIL',code:e.code??'ERROR',message:String(e.message).replace(/postgres(?:ql)?:\/\/[^\s]+/g,'[redacted]')}));process.exitCode=1;});
