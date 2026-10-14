const assert=require('node:assert/strict');
const database=process.argv[2];
if(!/^cerp_qualify_1268_\d{14}$/.test(database||''))throw Error('Dedicated isolated database required');
const target=new URL(process.env.DATABASE_URL||'http://invalid');
if(target.pathname!=='/'+database||target.searchParams.get('host')!=='/var/run/postgresql')throw Error('Isolated local PostgreSQL socket required');
target.searchParams.set('options','-c role=cerp_app');
process.env.DATABASE_URL=target.toString();
const pool=require('../../../dist/config/database').default;
const {buildProformaPreview}=require('../../../dist/module/facturation/repository/proforma-preview.repository');
const {repoCreateProforma,repoIssueProforma}=require('../../../dist/module/facturation/repository/proforma-command.repository');
const {repoRefreshProforma,repoCancelProforma}=require('../../../dist/module/facturation/repository/proforma-lifecycle.repository');
const {repoGetProforma,repoListProformas}=require('../../../dist/module/facturation/repository/proforma-read.repository');
const {repoAssignProformaReceipts,repoReleaseProformaReceipt}=require('../../../dist/module/facturation/repository/proforma-receipts.repository');
const {readProformaDepositInvoiceSources,buildProformaDepositInvoiceLine}=require('../../../dist/module/facturation/repository/proforma-deposit-invoice.repository');

async function main(){
  assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name,database);
  assert.equal((await pool.query('SELECT current_user AS role')).rows[0].role,'cerp_app');
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
  // Fiscal rows below are explicit storage fixtures, not issued by Finance.
  // They qualify actual receipt repositories without claiming legal issuance.
  const fundingPreview=await buildProformaPreview(pool,selection,false);
  const funding=await repoCreateProforma({actor,idempotencyKey:'qualification-funding-create',input:{...selection,preview_hash:fundingPreview.preview_hash}});
  const target=(await pool.query(`SELECT part.id FROM public.proforma_billing_parts part JOIN public.proforma_affair_lines line ON line.id=part.proforma_line_id
    WHERE line.proforma_id=$1 AND part.billed_client_id=$2`,[funding.id,clientId('Qualification société A')])).rows[0].id;
  const seed=await pool.connect();
  try{
    await seed.query('BEGIN');
    await seed.query(`UPDATE public.proforma_client SET status='ISSUED',row_version=2,issued_at=now(),issued_by=7,
      issued_snapshot='{"synthetic_fiscal_storage_fixture":true}' WHERE id=$1`,[funding.id]);
    await seed.query("INSERT INTO public.facture(id,numero,client_id,statut,total_ht,total_tax,total_ttc,currency,date_emission) VALUES(1268201,'QUAL-SYNTHETIC-ADVANCE', $1,'DRAFT',100,20,120,'EUR','2026-10-13')",[clientId('Qualification société A')]);
    await seed.query("INSERT INTO public.facture_ligne(id,facture_id,designation,quantite,prix_unitaire_ht,taux_tva,total_ht,tax_amount,total_ttc) VALUES(1268201,1268201,'Acompte synthétique isolé',1,100,20,100,20,120)");
    await seed.query(`INSERT INTO public.facture_source_allocations(id,facture_id,facture_ligne_id,source_type,source_id,source_line_id,quantity_selected,amount_ex_tax,amount_incl_tax,source_snapshot,rule_code,created_by)
      VALUES('12682000-0000-4000-8000-000000000001',1268201,1268201,'DEPOSIT',$1,$2,1,100,120,'{"synthetic_fiscal_storage_fixture":true}','PROFORMA_DEPOSIT_V1',7)`,[funding.id,target]);
    await seed.query("INSERT INTO public.proforma_deposit_sources(facture_source_allocation_id,proforma_billing_part_id,created_by,correlation_id) VALUES('12682000-0000-4000-8000-000000000001',$1,7,'12682000-0000-4000-8000-000000000099')",[target]);
    await seed.query("UPDATE public.facture_source_allocations SET allocation_status='CONSUMED',quantity_consumed=1 WHERE facture_id=1268201");
    await seed.query(`UPDATE public.facture SET statut='ISSUED',document_status='ISSUED',legal_number='QUAL-SYNTHETIC-NO-LEGAL-SEQUENCE',issued_at=now(),issued_by=7,
      immutable_snapshot='{"invoice_type_code":"386","synthetic_fiscal_storage_fixture":true}',document_checksum_sha256=repeat('d',64),row_version=2 WHERE id=1268201`);
    await seed.query("INSERT INTO public.paiement(id,uuid,client_id,montant,status,workflow_status,currency) VALUES(1268201,'12682000-0000-4000-8000-000000000002',$1,120,'ALLOCATED','ALLOCATED','EUR')",[clientId('Qualification société A')]);
    await seed.query("INSERT INTO public.paiement_allocations(id,paiement_id,facture_id,amount_ttc,created_by,correlation_id) VALUES('12682000-0000-4000-8000-000000000003',1268201,1268201,120,7,'12682000-0000-4000-8000-000000000099')");
    await seed.query('COMMIT');
  }catch(error){await seed.query('ROLLBACK');throw error;}finally{seed.release();}
  const depositSources=await readProformaDepositInvoiceSources(pool,[target],false);
  assert.equal(depositSources.length,1);
  assert.equal(buildProformaDepositInvoiceLine(depositSources[0],{source_type:'DEPOSIT',source_id:funding.id,source_line_id:target,quantity:'1.000',advance_amount_ex_tax:'200.00'},clientId('Qualification société A'),'EUR').total_incl_tax,'240.00');
  const assignmentInput={payment_allocation_id:'12682000-0000-4000-8000-000000000003',assignments:[{proforma_billing_part_id:target,deposit_source_id:'12682000-0000-4000-8000-000000000001',amount:'100.00'}]};
  const assigned=await repoAssignProformaReceipts({actor,id:funding.id,idempotencyKey:'qualification-receipt-assignment',input:assignmentInput});
  assert.equal(assigned.assignments.length,1);
  const assignedReplay=await repoAssignProformaReceipts({actor,id:funding.id,idempotencyKey:'qualification-receipt-assignment',input:assignmentInput});assert.equal(assignedReplay.idempotent_replay,true);
  const released=await repoReleaseProformaReceipt({actor,id:funding.id,assignmentId:assigned.assignments[0].id,idempotencyKey:'qualification-receipt-release',input:{amount:'20.00',reason:'Qualification libération partielle',confirm:true}});
  assert.equal(released.released_amount,'20.00');
  const covered=(await repoGetProforma(funding.id)).funding.find(part=>part.id===target);assert.equal(covered.paidAmount,'80.00');assert.equal(covered.status,'PARTIALLY_PAID');
  await assert.rejects(()=>repoAssignProformaReceipts({actor,id:funding.id,idempotencyKey:'qualification-receipt-overflow',input:{...assignmentInput,assignments:[{...assignmentInput.assignments[0],amount:'40.01'}]}}),error=>error.code==='PROFORMA_RECEIPT_BUDGET_EXCEEDED');
  console.log(JSON.stringify({marker:'PROFORMA1268_RECEIPT_REPOSITORIES_PASS',paidAmount:'80.00',fiscalRows:'synthetic storage fixtures only; no legal sequence, Finance issuance or external payment',businessRecipePassed:false}));
  await require('./prepayment-snapshot-concurrency-1268.cjs')(pool,database);
  await require('./delivery-prepayment-sql-rehearsal-1268.cjs')(pool,database,selection.client_id);
  await require('./proforma-final-invoice-rehearsal-1268.cjs')(pool,database,{physicalClientId:selection.client_id,
    billedClientId:clientId('Qualification société A'),proformaId:funding.id,partId:target});
  const commercialSelection={client_id:selection.client_id,currency:'EUR',affairs:[{allocation_id:1268002,
    billing_parts:[{billed_client_id:clientId('Qualification société A'),quantity:'10.000'}]}]};
  const commercialPreview=await buildProformaPreview(pool,commercialSelection,false);
  const commercial=await repoCreateProforma({actor,idempotencyKey:'qualification-commercial-pdf-create',
    input:{...commercialSelection,preview_hash:commercialPreview.preview_hash}});
  const issueArgs={actor,id:commercial.id,idempotencyKey:'qualification-commercial-pdf-issue',
    input:{expected_version:1,preview_hash:commercialPreview.preview_hash,confirm:true}};
  const issued=await repoIssueProforma(issueArgs),issuedReplay=await repoIssueProforma(issueArgs);
  assert.equal(issuedReplay.idempotent_replay,true);assert.equal(issued.document_archive_id,issuedReplay.document_archive_id);
  const archived=(await pool.query(`SELECT id::text,exact_pdf_bytes,source_snapshot,exact_pdf_sha256
    FROM public.authoritative_pdf_archives WHERE entity_type='proforma' AND entity_id=$1`,[commercial.id])).rows;
  assert.equal(archived.length,1);assert.equal(archived[0].exact_pdf_bytes.subarray(0,5).toString(),'%PDF-');
  assert.equal(archived[0].source_snapshot.reference,issued.reference);
  assert.equal(archived[0].source_snapshot.fiscal_invoice_created,false);
  assert.equal(archived[0].source_snapshot.template_version,'proforma/1.1');
  assert.equal(require('node:crypto').createHash('sha256').update(archived[0].exact_pdf_bytes).digest('hex'),archived[0].exact_pdf_sha256);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.finance_legal_sequences')).rows[0].n,0);
  console.log(JSON.stringify({marker:'PROFORMA1268_COMMERCIAL_PDF_ISSUE_PASS',actualCommercialIssuance:true,immutableExactBytes:true,
    archiveIntents:1,idempotentReplay:true,legalSequenceConsumed:false,gedFilingExecuted:false,uiRecipe:false}));
  await require('./document-tax-accounting-rehearsal-1268.cjs')(pool,database,{billedClientId:clientId('Qualification société A')});
}
main().catch(error=>{console.error(JSON.stringify({marker:'PROFORMA1268_REPOSITORY_COMMANDS_FAIL',code:error.code||error.name,message:error.message}));process.exitCode=1;}).finally(()=>pool.end());
