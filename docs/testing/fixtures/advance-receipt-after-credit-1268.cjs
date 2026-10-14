const assert=require('node:assert/strict');
const {allocateDocumentTaxBreakdown}=require('../../../dist/module/facturation/domain/document-tax-breakdown');
const {repoPreviewAvoir,repoCreateAvoirDraft}=require('../../../dist/module/facturation/repository/avoir-workflow.repository');
const {freezeAdvanceCreditVat}=require('../../../dist/module/facturation/repository/advance-credit-vat.repository');
const {repoRegisterPayment}=require('../../../dist/module/facturation/repository/payment-workflow.repository');
const {avoirPreviewBodySchema,createAvoirDraftBodySchema,registerPaymentBodySchema}=require('../../../dist/module/facturation/validators/workflow.validators');
const {createAccountingPreviewSchema}=require('../../../dist/module/accounting-export/accounting-export.validators');
const accounting=require('../../../dist/module/accounting-export/accounting-export.repository');

module.exports=async function qualifyReceiptAfterCredit(pool,database,args){
 assert.match(database,/^cerp_qualify_1268_\d{14}$/);
 const invoiceId=1268562,actor={userId:7,requestId:'qualification-credit-before-receipt',path:'/qualification/advance-credit-receipt'};
 const model=allocateDocumentTaxBreakdown({lines:[{ratePercent:'20',net:'100.00',tax:'20.00'}],totalExTax:'100.00',totalTax:'20.00',totalInclTax:'120.00'});
 await pool.query(`INSERT INTO public.facture(id,numero,client_id,statut,total_ht,total_tax,total_ttc,currency,date_emission)
   VALUES($1,'QUAL-ADV-CREDIT-FIRST',$2,'DRAFT',100,20,120,'EUR',$3)`,[invoiceId,args.billedClientId,args.date]);
 await pool.query(`INSERT INTO public.facture_ligne(id,facture_id,ordre,designation,quantite,prix_unitaire_ht,taux_tva,total_ht,tax_amount,total_ttc)
   VALUES($1,$1,1,'Acompte réduit avant encaissement',1,100,20,100,20,120)`,[invoiceId]);
 await pool.query(`UPDATE public.facture SET statut='ISSUED',document_status='ISSUED',legal_number='QUAL-CREDIT-FIRST-NO-SEQUENCE',issued_at=now(),issued_by=7,
   immutable_snapshot=$2::jsonb,document_checksum_sha256=repeat('b',64),row_version=2 WHERE id=$1`,
   [invoiceId,JSON.stringify({invoice_type_code:386,tax_breakdown:model,synthetic_storage_fixture:true})]);
 const input=avoirPreviewBodySchema.parse({facture_id:invoiceId,reason_code:'COMMERCIAL_GESTURE',reason:'Réduction fictive avant encaissement',lines:[{facture_line_id:invoiceId,quantity:'0.5'}]});
 const preview=await repoPreviewAvoir(input);
 const credit=await repoCreateAvoirDraft({actor,idempotencyKey:'qual-credit-before-payment',input:createAvoirDraftBodySchema.parse({...input,preview_hash:preview.preview_hash})});
 const tx=await pool.connect();try{
   await tx.query('BEGIN');await tx.query('SELECT public.fn_lock_delivery_prepayment_write_1268()');
   const frozen=await freezeAdvanceCreditVat(tx,invoiceId,preview.tax_breakdown);
   assert.equal(frozen.entries[0].pending_tax,'10.00');assert.equal(frozen.entries[0].collected_tax,'0.00');
   await tx.query("UPDATE public.avoir_source_allocations SET allocation_status='CONSUMED',quantity_credited=quantity_selected,consumed_at=now(),consumed_by=7 WHERE avoir_id=$1",[credit.id]);
   // Only fiscal issuance storage is simulated; payment/export commands are real.
   await tx.query(`UPDATE public.avoir SET statut='ISSUED',legal_number='QUAL-CREDIT-FIRST-SIMULATED',date_emission=$2,issued_at=now(),issued_by=7,
     immutable_snapshot=$3::jsonb,document_checksum_sha256=repeat('d',64),row_version=row_version+1 WHERE id=$1`,
     [credit.id,args.date,JSON.stringify({synthetic_fiscal_storage_fixture:true,tax_breakdown:preview.tax_breakdown,advance_credit_vat:frozen})]);
   await tx.query('COMMIT');
 }catch(error){await tx.query('ROLLBACK');throw error;}finally{tx.release();}
 const batches=[],payments=[];
 for(const [index,amount,tax]of[[0,'40.00','6.67'],[1,'20.00','3.33']]){
   const command={actor,idempotencyKey:'qual-credit-first-cash-'+index,input:registerPaymentBodySchema.parse({client_id:args.billedClientId,
     value_date:args.date,booking_date:args.date,amount,currency:'EUR',mode:'VIREMENT',reference:'QUAL-NO-EXTERNAL-CREDIT-FIRST-'+index,
     allocations:[{target_type:'FACTURE',target_id:String(invoiceId),amount}]})};
   const payment=await repoRegisterPayment(command),replay=await repoRegisterPayment(command);payments.push(payment.id);
   assert.equal(replay.id,payment.id);assert.equal(replay.idempotent_replay,true);
   const saved=(await pool.query('SELECT advance_vat_snapshot FROM public.paiement_allocations WHERE paiement_id=$1',[payment.id])).rows[0].advance_vat_snapshot;
   assert.equal(saved.version,2);assert.equal(saved.adjustment.credited_gross,'60.00');assert.equal(saved.entries[0].tax_amount,tax);
   const ledger=await accounting.repoCreateAccountingPreview({actor,idempotencyKey:'qual-credit-first-ledger-'+index,input:createAccountingPreviewSchema.parse({
     mapping_version_id:args.mappingId,period_from:args.date,period_to:args.date,source_types:['INVOICE','CREDIT_NOTE','PAYMENT'],only_unexported:true})});
   assert.equal(ledger.findings.length,0);assert.equal(ledger.source_count,index===0?4:2);
   const valid=await accounting.repoValidateAccountingBatch({batchId:ledger.id,body:{expected_version:ledger.row_version},actor,idempotencyKey:'qual-credit-first-valid-'+index});
   const generated=await accounting.repoGenerateAccountingBatch({batchId:ledger.id,body:{expected_version:valid.row_version},actor,idempotencyKey:'qual-credit-first-generate-'+index});
   batches.push(generated.id);
 }
 await assert.rejects(()=>repoRegisterPayment({actor,idempotencyKey:'qual-credit-first-overpayment',input:registerPaymentBodySchema.parse({
   client_id:args.billedClientId,value_date:args.date,booking_date:args.date,amount:'0.01',currency:'EUR',mode:'VIREMENT',reference:'QUAL-REFUSED-CREDIT-FIRST',
   allocations:[{target_type:'FACTURE',target_id:String(invoiceId),amount:'0.01'}]})}),error=>error.code==='PAYMENT_INVOICE_BALANCE_EXCEEDED');
 const balances=(await pool.query(`SELECT account_number,sum(debit-credit)::numeric(18,2)::text AS balance FROM public.accounting_export_entries
   WHERE batch_id=ANY($1::uuid[]) GROUP BY account_number`,[batches])).rows;
 const balance=account=>balances.find(row=>row.account_number===account)?.balance??'0.00';
 assert.equal(balance('512QUAL'),'60.00');assert.equal(balance('419100QUAL'),'-50.00');assert.equal(balance('445710QUAL'),'-10.00');
 assert.equal(balance('445800QUAL'),'0.00');assert.equal(balance('411QUAL1268'),'0.00');assert.equal(balance('701QUAL'),'0.00');
 await assert.rejects(()=>pool.query('UPDATE public.paiement_allocations SET amount_ttc=0.01 WHERE paiement_id=$1',[payments[0]]),error=>error.code==='55000');
 console.log(JSON.stringify({marker:'PROFORMA1268_RECEIPT_AFTER_CREDIT_PASS',qualifiedCreditBeforeCash:'60.00',actualPayments:2,paymentReplays:2,
   cashTotal:'60.00',vatEffects:['6.67','3.33'],actualGeneratedBatches:2,noDuplicateMoney:true,overpaymentRefused:true,
   fiscalIssuance:'explicit simulated storage',externalCash:false,uiRecipe:false,businessRecipePassed:false}));
};
