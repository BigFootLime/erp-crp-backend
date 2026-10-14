const assert=require('node:assert/strict');
const {readFinalInvoicePrepaymentReceipts,bindFinalInvoicePrepayments,readSavedFinalInvoicePrepayments}=require('../../../dist/module/facturation/repository/final-invoice-prepayments.repository');
const {planFinalInvoicePrepayments}=require('../../../dist/module/facturation/domain/final-invoice-prepayments');
const {lockInvoiceSettlement}=require('../../../dist/module/facturation/repository/invoice-settlement.repository');
const {moneyToCents}=require('../../../dist/module/facturation/domain/decimal-money');
const {allocateDocumentTaxBreakdown}=require('../../../dist/module/facturation/domain/document-tax-breakdown');
const {freezeAdvanceVat}=require('../../../dist/module/facturation/repository/advance-vat.repository');
const {freezeAdvanceClearing}=require('../../../dist/module/facturation/repository/advance-clearing.repository');
const {accountingFinanceKind}=require('../../../dist/module/accounting-export/accounting-finance-kind');
const {buildAccountingPreview}=require('../../../dist/module/accounting-export/accounting-export.domain');

/** Real repository/SQL guards against synthetic fiscal storage, never business acceptance. */
module.exports=async function qualifyFinalPrepayments(pool,database,args){
 assert.match(database,/^cerp_qualify_1268_\d{14}$/);
 const invoiceId=1268401,sourceId='12684100-0000-4000-8000-000000000001';
 const correlationId='12684200-0000-4000-8000-000000000099';
 const targets=[{source_line_id:args.sourceLineId,billing_part_id:args.partId,amount_incl_tax:'158.40'}];
 const planArgs={billedClientId:args.billedClientId,currency:'EUR',invoiceTotalInclTax:'158.40',targets};
 const sourceIds=new Map([[args.sourceLineId,sourceId]]);
 const receipts=await readFinalInvoicePrepaymentReceipts(pool,{partIds:[args.partId],clientId:args.billedClientId,currency:'EUR'});
 const originalPaymentCount=(await pool.query('SELECT count(*)::int AS n FROM public.paiement')).rows[0].n;
 assert.equal(receipts.length,1);assert.equal(receipts[0].available_amount,'80.00');
 const plan=planFinalInvoicePrepayments({...planArgs,receipts});
 assert.equal(plan.amount_paid,'80.00');assert.equal(plan.amount_due,'78.40');
 const tx=await pool.connect();let failures=0;
 async function refused(work){
  const savepoint='prepaid_refusal_'+(++failures);await tx.query('SAVEPOINT '+savepoint);
  let rejected;
  try{await work();await tx.query('SET CONSTRAINTS ALL IMMEDIATE');}catch(error){rejected=error;}
  await tx.query('ROLLBACK TO SAVEPOINT '+savepoint);await tx.query('RELEASE SAVEPOINT '+savepoint);
  await tx.query('SET CONSTRAINTS ALL DEFERRED');
  assert.equal(rejected?.code,'23514');
 }
 try{
  await tx.query('BEGIN');await tx.query('SELECT public.fn_lock_delivery_prepayment_write_1268()');
  await bindFinalInvoicePrepayments(tx,{invoiceId,plan,sourceIds,actorId:7,correlationId});
  await tx.query("INSERT INTO public.facture_echeance(facture_id,due_date,label,amount_due,amount_autofilled,status,created_by) VALUES($1,'2026-11-30','Solde',78.40,true,'OPEN',7)",[invoiceId]);
  await tx.query('SET CONSTRAINTS ALL IMMEDIATE');await tx.query('SET CONSTRAINTS ALL DEFERRED');
  const saved=await readSavedFinalInvoicePrepayments(tx,invoiceId);assert.equal(saved.amount_due,'78.40');assert.equal(saved.applications.length,1);
  const remaining=await readFinalInvoicePrepaymentReceipts(tx,{partIds:[args.partId],clientId:args.billedClientId,currency:'EUR'});
  assert.equal(remaining[0].available_amount,'0.00');
  const own=await readFinalInvoicePrepaymentReceipts(tx,{partIds:[args.partId],clientId:args.billedClientId,currency:'EUR',ownInvoiceId:invoiceId});
  assert.equal(own[0].available_amount,'80.00');
  const sqlTarget=(await tx.query('SELECT amount_ttc::numeric(18,2)::text AS amount FROM public.fn_final_prepayment_targets_1268($1)',[invoiceId])).rows;
  assert.equal(sqlTarget.length,1);assert.equal(moneyToCents(sqlTarget[0].amount),15840n);
  await refused(()=>tx.query('UPDATE public.facture_echeance SET amount_due=79.40 WHERE facture_id=$1',[invoiceId]));
  await refused(()=>tx.query(`INSERT INTO public.proforma_receipt_releases(assignment_id,amount_ttc,reason,created_by,correlation_id)
    VALUES($1,0.01,'Cannot release already applied cash',7,$2)`,[receipts[0].assignment_id,correlationId]));
  const another=(await tx.query(`SELECT final.id FROM public.proforma_final_invoice_sources binding JOIN public.facture_source_allocations final ON final.id=binding.facture_source_allocation_id
    WHERE binding.proforma_billing_part_id=$1 AND final.id<>$2 AND final.allocation_status='DRAFT'`,[args.partId,sourceId])).rows[0].id;
  await refused(()=>tx.query(`INSERT INTO public.proforma_final_prepayments(final_source_allocation_id,proforma_billing_part_id,receipt_assignment_id,deposit_source_id,
    amount_ex_tax,tax_amount,amount_ttc,created_by,correlation_id) VALUES($1,$2,$3,$4,0.01,0,0.01,7,$5)`,
    [another,args.partId,receipts[0].assignment_id,receipts[0].deposit_source_id,correlationId]));

  // Supplementary paid advance is explicit synthetic storage, without a legal sequence or external cash.
  const extraSource='12684200-0000-4000-8000-000000000001',extraReceipt='12684200-0000-4000-8000-000000000004';
  await tx.query(`INSERT INTO public.facture(id,numero,client_id,statut,total_ht,total_tax,total_ttc,currency,date_emission)
    VALUES(1268202,'QUAL-SYNTHETIC-SECOND-ADVANCE',$1,'DRAFT',80,16,96,'EUR','2026-10-14')`,[args.billedClientId]);
  await tx.query("INSERT INTO public.facture_ligne(id,facture_id,designation,quantite,prix_unitaire_ht,taux_tva,total_ht,tax_amount,total_ttc) VALUES(1268202,1268202,'Second acompte synthétique isolé',1,80,20,80,16,96)");
  await tx.query(`INSERT INTO public.facture_source_allocations(id,facture_id,facture_ligne_id,source_type,source_id,source_line_id,quantity_selected,amount_ex_tax,amount_incl_tax,source_snapshot,rule_code,created_by)
    VALUES($1,1268202,1268202,'DEPOSIT',$2,$3,1,80,96,'{"synthetic_storage_fixture":true}','PROFORMA_DEPOSIT_V1',7)`,[extraSource,args.proformaId,args.partId]);
  await tx.query('INSERT INTO public.proforma_deposit_sources(facture_source_allocation_id,proforma_billing_part_id,created_by,correlation_id) VALUES($1,$2,7,$3)',[extraSource,args.partId,correlationId]);
  await tx.query("UPDATE public.facture_source_allocations SET allocation_status='CONSUMED',quantity_consumed=1 WHERE facture_id=1268202");
  await tx.query(`UPDATE public.facture SET statut='ISSUED',document_status='ISSUED',legal_number='QUAL-SYNTHETIC-SECOND-NO-SEQUENCE',issued_at=now(),issued_by=7,
    immutable_snapshot=$1::jsonb,document_checksum_sha256=repeat('d',64),row_version=2 WHERE id=1268202`,[JSON.stringify({invoice_type_code:'386',synthetic_storage_fixture:true,
      tax_breakdown:allocateDocumentTaxBreakdown({lines:[{ratePercent:'20',net:'80.00',tax:'16.00'}],totalExTax:'80.00',totalTax:'16.00',totalInclTax:'96.00'})})]);
  await tx.query(`INSERT INTO public.paiement(id,uuid,client_id,montant,status,workflow_status,currency) VALUES(1268202,'12684200-0000-4000-8000-000000000002',$1,96,'ALLOCATED','ALLOCATED','EUR')`,[args.billedClientId]);
  const cashVat=await freezeAdvanceVat(tx,{invoiceId:1268202,paymentId:1268202,amount:'96.00'});
  await tx.query(`INSERT INTO public.paiement_allocations(id,paiement_id,facture_id,amount_ttc,created_by,correlation_id,advance_vat_snapshot) VALUES('12684200-0000-4000-8000-000000000003',1268202,1268202,96,7,$1,$2::jsonb)`,[correlationId,JSON.stringify(cashVat)]);
  await tx.query(`INSERT INTO public.proforma_receipt_assignments(id,payment_allocation_id,deposit_source_id,amount_ttc,created_by,correlation_id)
    VALUES($1,'12684200-0000-4000-8000-000000000003',$2,96,7,$3)`,[extraReceipt,extraSource,correlationId]);
  const full=planFinalInvoicePrepayments({...planArgs,receipts:await readFinalInvoicePrepaymentReceipts(tx,{partIds:[args.partId],clientId:args.billedClientId,currency:'EUR',ownInvoiceId:invoiceId})});
  assert.equal(full.amount_paid,'158.40');assert.equal(full.amount_due,'0.00');
  await bindFinalInvoicePrepayments(tx,{invoiceId,plan:{...full,applications:full.applications.filter(a=>a.deposit_source_id===extraSource)},sourceIds,actorId:7,correlationId});
  await tx.query('UPDATE public.facture_echeance SET amount_due=0 WHERE facture_id=$1',[invoiceId]);
  await tx.query('SET CONSTRAINTS ALL IMMEDIATE');await tx.query('SET CONSTRAINTS ALL DEFERRED');
  await tx.query("UPDATE public.facture_source_allocations SET allocation_status='CONSUMED',quantity_consumed=quantity_selected WHERE id=$1",[sourceId]);
  await tx.query(`UPDATE public.facture SET statut='PAID',document_status='ISSUED',settlement_status='PAID',legal_number='QUAL-SYNTHETIC-FINAL-NO-SEQUENCE',issued_at=now(),issued_by=7,
    immutable_snapshot=$2::jsonb,document_checksum_sha256=repeat('d',64),row_version=2 WHERE id=$1`,[invoiceId,JSON.stringify({synthetic_storage_fixture:true,prepayments:full,
      advance_clearing:await freezeAdvanceClearing(tx,invoiceId,full.amount_paid)})]);
  await tx.query('SET CONSTRAINTS ALL IMMEDIATE');await tx.query('SET CONSTRAINTS ALL DEFERRED');
  assert.equal((await lockInvoiceSettlement(tx,invoiceId)).settledAmount,'158.40');
  const finalFacts=(await tx.query(`SELECT immutable_snapshot AS fiscal_snapshot,total_ht::numeric(18,2)::text AS total_ex_tax,
    total_tax::numeric(18,2)::text AS total_tax,total_ttc::numeric(18,2)::text AS total_incl_tax FROM public.facture WHERE id=$1`,[invoiceId])).rows[0];
  const finalLedger=buildAccountingPreview([accountingFinanceKind({...finalFacts,source_type:'INVOICE',source_id:String(invoiceId),source_number:'QUAL-FINAL',
    source_updated_at:'2026-10-14T08:00:00Z',entry_date:'2026-10-14',client_id:args.billedClientId,third_party_account:'411QUAL',currency:'EUR',payment_mode:null,
    claimed_batch_id:null,tax_breakdown:[{tax_rate:'20',total_ex_tax:finalFacts.total_ex_tax,tax_amount:finalFacts.total_tax}]})],{
      delimiter:';',sales_journal:'VE',credit_journal:'AV',bank_journal_by_mode:{},bank_account_by_mode:{},default_bank_journal:null,default_bank_account:null,
      sales_account_by_tax:{'20':'701QUAL'},vat_output_account_by_tax:{'20':'445710QUAL'},advance_account_by_tax:{'20':'419100QUAL'},
      advance_vat_pending_account_by_tax:{'20':'445800QUAL'},default_axes:{}});
  assert.equal(finalLedger.findings.length,0);assert.equal(finalLedger.currency_totals[0].balanced,true);
  const accountBalance=account=>finalLedger.lines.filter(line=>line.account_number===account)
    .reduce((sum,line)=>sum+moneyToCents(line.debit)-moneyToCents(line.credit),0n);
  assert.equal(accountBalance('411QUAL'),0n);assert.equal(accountBalance('419100QUAL'),13200n);
  assert.equal(accountBalance('701QUAL'),-13200n);assert.equal(accountBalance('445710QUAL'),0n);
  assert.equal((await tx.query('SELECT count(*)::int AS n FROM public.paiement')).rows[0].n,originalPaymentCount+1);
  await refused(()=>tx.query(`INSERT INTO public.paiement(id,uuid,client_id,facture_id,montant,status,workflow_status,currency)
    VALUES(1268203,'12684200-0000-4000-8000-000000000005',$1,$2,0.01,'ALLOCATED','ALLOCATED','EUR')`,[args.billedClientId,invoiceId]));
  console.log(JSON.stringify({marker:'PROFORMA1268_FINAL_PREPAYMENTS_PASS',partialDue:'78.40',fullyPrepaidDue:'0.00',
    originalPaymentsOnly:2,duplicateAdvanceRefused:true,usedCashReleaseRefused:true,excessCollectionRefused:true,
    installmentsAndSnapshotSealed:true,applicationRepositoryExecuted:true,finalClearingSnapshotQualified:true,finalLedgerFromStoredFacts:true,storageOnly:true,
    actualFiscalIssuance:false,realCash:false,uiRecipe:false,businessRecipePassed:false}));
 }finally{await tx.query('ROLLBACK');tx.release();}
};
