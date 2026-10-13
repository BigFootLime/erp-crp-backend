const assert=require('node:assert/strict');

/** Only called by the isolated PostgreSQL fixture runner; no business mutation. */
module.exports=async function qualifyPrepaymentSnapshot(pool,database){
  assert.match(database,/^cerp_qualify_1268_\d{14}$/);
  const reader=await pool.connect(),writer=await pool.connect();
  // App-role pg_stat_activity intentionally hides other session wait details.
  // Observe only this synthetic writer PID through the fixture's peer owner.
  const observerTarget=new URL(process.env.DATABASE_URL);observerTarget.searchParams.delete('options');
  const observer=new (require('pg').Client)({connectionString:observerTarget.toString()});
  let waiting;
  try{
    await observer.connect();
    assert.equal((await observer.query('SELECT current_database() AS name')).rows[0].name,database);
    await reader.query('SET statement_timeout=\'5s\'');
    await writer.query('SET statement_timeout=\'5s\'');
    // Establish the same old snapshot created by a shipment idempotency read.
    await reader.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await reader.query('SELECT count(*) FROM public.finance_command_receipts');
    await writer.query('BEGIN');
    // BEFORE STATEMENT fiscal trigger participates even when no rows match.
    await writer.query('UPDATE public.paiement SET status=status WHERE id=-1268');
    await writer.query('COMMIT');
    await assert.rejects(()=>reader.query('SELECT public.fn_lock_delivery_prepayment_read_1268()'),error=>error.code==='40001');
    await reader.query('ROLLBACK');
    // A fresh read guard remains valid and blocks a concurrent Finance writer.
    await reader.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await reader.query('SELECT public.fn_lock_delivery_prepayment_read_1268()');
    const pid=(await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await writer.query('BEGIN');
    let settled=false;
    waiting=writer.query('SELECT public.fn_lock_delivery_prepayment_write_1268()').then(result=>{settled=true;return result;});
    let waitVerified=false;
    for(let attempt=0;attempt<30;attempt++){
      const activity=(await observer.query('SELECT wait_event_type,wait_event FROM pg_stat_activity WHERE pid=$1',[pid])).rows[0];
      if(activity?.wait_event_type==='Lock'&&activity?.wait_event==='advisory'){waitVerified=true;break;}
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal(waitVerified,true,'Finance writer must actually wait on the protected BL guard');
    assert.equal(settled,false);
    await reader.query('COMMIT');
    await waiting;
    await writer.query('COMMIT');
    console.log(JSON.stringify({marker:'PROFORMA1268_SNAPSHOT_CONCURRENCY_PASS',staleShipmentSnapshot:'40001',
      concurrentFinanceWriter:'wait verified in pg_stat_activity, released after BL commit',businessRecipePassed:false}));
  }finally{
    await reader.query('ROLLBACK');
    if(waiting) await waiting.catch(()=>{});
    await writer.query('ROLLBACK');reader.release();writer.release();await observer.end();
  }
};
