const assert=require('node:assert/strict');
const database=process.argv[2];
if(!/^cerp_qualify_1268_\d{14}$/.test(database||''))throw Error('Dedicated isolated database required');
const target=new URL(process.env.DATABASE_URL||'http://invalid');
if(target.pathname!=='/'+database||target.searchParams.get('host')!=='/var/run/postgresql')throw Error('Isolated local PostgreSQL socket required');
const pool=require('../../../dist/config/database').default;
const {buildProformaPreview}=require('../../../dist/module/facturation/repository/proforma-preview.repository');
const {repoCreateProforma,repoIssueProforma}=require('../../../dist/module/facturation/repository/proforma-command.repository');
const {repoRefreshProforma,repoCancelProforma}=require('../../../dist/module/facturation/repository/proforma-lifecycle.repository');
const {repoGetProforma,repoListProformas}=require('../../../dist/module/facturation/repository/proforma-read.repository');

pool.on('connect',client=>client.query('SET ROLE cerp_app'));
async function main(){
  assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name,database);
  const clients=(await pool.query("SELECT client_id,company_name FROM public.clients ORDER BY company_name")).rows;
  const clientId=name=>clients.find(c=>c.company_name===name).client_id;
  const selection={client_id:clientId('Qualification client'),currency:'EUR',affairs:[{allocation_id:1268001,billing_parts:[
    {billed_client_id:clientId('Qualification société A'),quantity:'30.000'},
    {billed_client_id:clientId('Qualification société B'),quantity:'70.000'},
  ]}]};
  const actor={userId:7,requestId:'isolated-command-qualification',path:'/qualification/proformas'};
  const initialSelection={...selection,affairs:[...selection.affairs,{allocation_id:1268002,billing_parts:[{billed_client_id:clientId('Qualification société A'),quantity:'10.000'}]}]};
  const preview=await buildProformaPreview(pool,initialSelection,false);
  assert.equal(preview.company_totals[0].total_incl_tax,'420.00');
  assert.equal(preview.company_totals[1].total_incl_tax,'840.00');
  const creation={actor,idempotencyKey:'qualification-create-original',input:{...initialSelection,preview_hash:preview.preview_hash}};
  const first=await repoCreateProforma(creation),replay=await repoCreateProforma(creation);
  assert.equal(first.status,'DRAFT');assert.equal(replay.id,first.id);assert.equal(replay.idempotent_replay,true);
  const lineId=(await pool.query('SELECT id FROM public.proforma_affair_lines WHERE proforma_id=$1 AND allocation_id=1268001',[first.id])).rows[0].id;
  await pool.query('UPDATE public.commande_ligne SET prix_unitaire_ht=11 WHERE id=1268001');
  await assert.rejects(()=>repoIssueProforma({actor,id:first.id,idempotencyKey:'qualification-stale-issue',
    input:{expected_version:1,preview_hash:preview.preview_hash,confirm:true}}),error=>error.code==='PROFORMA_PREVIEW_CHANGED');
  const changed=await buildProformaPreview(pool,selection,false,first.id);
  const refresh=await repoRefreshProforma({actor,id:first.id,idempotencyKey:'qualification-refresh-original',
    input:{...selection,expected_version:1,preview_hash:changed.preview_hash,confirm:true}});
  assert.equal(refresh.row_version,2);
  assert.equal((await pool.query('SELECT id FROM public.proforma_affair_lines WHERE proforma_id=$1',[first.id])).rows[0].id,lineId);
  assert.equal((await pool.query('SELECT count(*)::int AS lines FROM public.proforma_affair_lines WHERE proforma_id=$1',[first.id])).rows[0].lines,1);
  assert.equal((await pool.query('SELECT requirement,proforma_line_id FROM public.delivery_affair_prepayment_terms WHERE allocation_id=1268002')).rows[0].requirement,'UNCONFIRMED');
  assert.equal((await pool.query('SELECT proforma_line_id FROM public.delivery_affair_prepayment_terms WHERE allocation_id=1268002')).rows[0].proforma_line_id,null);
  assert.equal((await pool.query('SELECT sum(total_incl_tax)::text AS total FROM public.proforma_billing_parts WHERE proforma_line_id=$1',[lineId])).rows[0].total,'1320.00');
  await assert.rejects(()=>repoRefreshProforma({actor,id:first.id,idempotencyKey:'qualification-stale-refresh',
    input:{...selection,expected_version:1,preview_hash:changed.preview_hash,confirm:true}}),error=>error.code==='PROFORMA_VERSION_CHANGED');
  const cancellation={actor,id:first.id,idempotencyKey:'qualification-cancel-original',input:{expected_version:2,reason:'Annulation de qualification sans encaissement',confirm:true}};
  const cancelled=await repoCancelProforma(cancellation),cancelReplay=await repoCancelProforma(cancellation);
  assert.equal(cancelled.status,'CANCELLED');assert.equal(cancelReplay.idempotent_replay,true);
  assert.equal((await pool.query('SELECT requirement FROM public.delivery_affair_prepayment_terms WHERE allocation_id=1268001')).rows[0].requirement,'PROFORMA');
  const revised=await buildProformaPreview(pool,selection,false);
  const attempts=await Promise.allSettled(['a','b'].map(key=>repoCreateProforma({actor,idempotencyKey:'qualification-concurrent-create-'+key,input:{...selection,preview_hash:revised.preview_hash}})));
  assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1);
  const rejected=attempts.find(r=>r.status==='rejected');assert.equal(rejected.reason.code,'PROFORMA_AFFAIR_ALREADY_BOUND');
  const winner=attempts.find(r=>r.status==='fulfilled').value;
  const detail=await repoGetProforma(winner.id);assert.equal(detail.funding.length,2);assert.equal(detail.funding.every(part=>part.status==='UNPAID'),true);
  const listing=await repoListProformas({q:'',page:1,pageSize:25});assert.equal(listing.total,2);
  await repoCancelProforma({actor,id:winner.id,idempotencyKey:'qualification-cancel-concurrent',input:{expected_version:1,reason:'Fin de qualification isolée',confirm:true}});
  const evidence=(await pool.query(`SELECT
    (SELECT count(*)::int FROM public.finance_command_receipts WHERE aggregate_type='PROFORMA') AS receipts,
    (SELECT count(*)::int FROM public.finance_event_log WHERE aggregate_type='PROFORMA') AS events,
    (SELECT count(*)::int FROM public.erp_outbox_events) AS outbox,
    (SELECT count(*)::int FROM public.facture) AS fiscal_invoices,
    (SELECT count(*)::int FROM public.proforma_client WHERE status='CANCELLED') AS cancelled_documents`)).rows[0];
  assert.equal(evidence.receipts,5);assert.equal(evidence.events,5);assert.ok(evidence.outbox>=10);
  assert.equal(evidence.fiscal_invoices,0);assert.equal(evidence.cancelled_documents,2);
  console.log(JSON.stringify({marker:'PROFORMA1268_REPOSITORY_COMMANDS_PASS',evidence,scope:'isolated actual repositories, PostgreSQL, audit, idempotency and outbox; no UI or payment recipe'}));
}
main().catch(error=>{console.error(JSON.stringify({marker:'PROFORMA1268_REPOSITORY_COMMANDS_FAIL',code:error.code||error.name,message:error.message}));process.exitCode=1;}).finally(()=>pool.end());
