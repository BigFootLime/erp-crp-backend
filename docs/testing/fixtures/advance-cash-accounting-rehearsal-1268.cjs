const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {allocateDocumentTaxBreakdown}=require('../../../dist/module/facturation/domain/document-tax-breakdown');
const {repoRegisterPayment}=require('../../../dist/module/facturation/repository/payment-workflow.repository');
const {registerPaymentBodySchema}=require('../../../dist/module/facturation/validators/workflow.validators');
const accounting=require('../../../dist/module/accounting-export/accounting-export.repository');
const {accountingMappingConfigSchema,createAccountingPreviewSchema}=require('../../../dist/module/accounting-export/accounting-export.validators');

module.exports=async function advanceCashAccounting(pool,database,args){
 assert.match(database,/^cerp_qualify_1268_\d{14}$/);
 const invoiceId=1268561,date='2026-09-21',actor={userId:7,requestId:'qualification-advance-cash',path:'/qualification/accounting-exports'};
 const model=allocateDocumentTaxBreakdown({lines:[{ratePercent:'20',net:'100.00',tax:'20.00'}],totalExTax:'100.00',totalTax:'20.00',totalInclTax:'120.00'});
 // Only the initial issued document state is simulated. Cash registration,
 // allocation, settlement updates and export commands below are real repositories.
 await pool.query(`INSERT INTO public.facture(id,numero,client_id,statut,total_ht,total_tax,total_ttc,currency,date_emission)
   VALUES($1,'QUAL-ADVANCE-CASH-STORAGE',$2,'DRAFT',100,20,120,'EUR',$3)`,[invoiceId,args.billedClientId,date]);
 await pool.query(`INSERT INTO public.facture_ligne(id,facture_id,ordre,designation,quantite,prix_unitaire_ht,taux_tva,total_ht,tax_amount,total_ttc)
   VALUES($1,$1,1,'Acompte fiscal isolé',1,100,20,100,20,120)`,[invoiceId]);
 await pool.query(`UPDATE public.facture SET statut='ISSUED',document_status='ISSUED',legal_number='QUAL-ADVANCE-CASH-NO-SEQUENCE',
   issued_at=now(),issued_by=7,immutable_snapshot=$2::jsonb,document_checksum_sha256=repeat('a',64),row_version=2 WHERE id=$1`,
   [invoiceId,JSON.stringify({invoice_type_code:386,tax_breakdown:model,synthetic_storage_fixture:true})]);
 const config=accountingMappingConfigSchema.parse({delimiter:';',sales_journal:'VE',credit_journal:'AV',bank_journal_by_mode:{},bank_account_by_mode:{},
   default_bank_journal:'BQ',default_bank_account:'512QUAL',sales_account_by_tax:{'20':'701QUAL'},vat_output_account_by_tax:{'20':'445710QUAL'},
   advance_account_by_tax:{'20':'419100QUAL'},advance_vat_pending_account_by_tax:{'20':'445800QUAL'},default_axes:{}});
 const mapping=await accounting.repoCreateAccountingMapping({actor,idempotencyKey:'qual-advance-cash-map',input:{version_code:'QUAL-ADVANCE-CASH',adapter_code:'GENERIC_DELIMITED_V1',effective_from:date,activate:true,config}});
 const payments=[],batches=[];
 for(const [index,amount,tax]of[[0,'80.00','13.33'],[1,'40.00','6.67']]){
   const command={actor,idempotencyKey:'qual-advance-cash-payment-'+index,input:registerPaymentBodySchema.parse({client_id:args.billedClientId,
     value_date:date,booking_date:date,amount,currency:'EUR',mode:'VIREMENT',reference:'QUAL-NO-EXTERNAL-CASH-'+index,
     allocations:[{target_type:'FACTURE',target_id:String(invoiceId),amount}]})};
   const payment=await repoRegisterPayment(command),replay=await repoRegisterPayment(command);payments.push(payment.id);
   assert.equal(replay.id,payment.id);assert.equal(replay.idempotent_replay,true);
   const saved=(await pool.query('SELECT advance_vat_snapshot FROM public.paiement_allocations WHERE paiement_id=$1',[payment.id])).rows;
   assert.equal(saved.length,1);assert.equal(saved[0].advance_vat_snapshot.entries[0].tax_amount,tax);
   if(index===0) await assert.rejects(()=>pool.query(`INSERT INTO public.paiement_allocations(paiement_id,facture_id,amount_ttc,created_by)
     VALUES($1,$2,0.01,7)`,[payment.id,invoiceId]),error=>error.code==='23514'&&error.message.includes('ADVANCE-VAT-1268'));
   const input=createAccountingPreviewSchema.parse({mapping_version_id:mapping.id,period_from:date,period_to:date,source_types:['INVOICE','PAYMENT'],only_unexported:true});
   assert.ok(input.source_types.includes('ADVANCE_VAT'));
   const preview=await accounting.repoCreateAccountingPreview({actor,idempotencyKey:'qual-advance-cash-preview-'+index,input});
   assert.equal(preview.findings.length,0);assert.equal(preview.source_count,index===0?3:2);
   const valid=await accounting.repoValidateAccountingBatch({batchId:preview.id,body:{expected_version:preview.row_version},actor,idempotencyKey:'qual-advance-cash-validate-'+index});
   const generated=await accounting.repoGenerateAccountingBatch({batchId:preview.id,body:{expected_version:valid.row_version},actor,idempotencyKey:'qual-advance-cash-generate-'+index});
   const artifact=await accounting.repoDownloadAccountingArtifact(generated.id);
   assert.equal(crypto.createHash('sha256').update(artifact.content).digest('hex'),artifact.sha256);
   batches.push(generated.id);
 }
 const balances=(await pool.query(`SELECT account_number,sum(debit-credit)::numeric(18,2)::text AS balance FROM public.accounting_export_entries
   WHERE batch_id=ANY($1::uuid[]) GROUP BY account_number`,[batches])).rows;
 const balance=account=>balances.find(row=>row.account_number===account)?.balance??'0.00';
 assert.equal(balance('512QUAL'),'120.00');assert.equal(balance('701QUAL'),'0.00');assert.equal(balance('419100QUAL'),'-100.00');
 assert.equal(balance('445800QUAL'),'0.00');assert.equal(balance('445710QUAL'),'-20.00');assert.equal(balance('411QUAL1268'),'0.00');
 await assert.rejects(()=>repoRegisterPayment({actor,idempotencyKey:'qual-advance-cash-overpayment',input:registerPaymentBodySchema.parse({
   client_id:args.billedClientId,value_date:date,booking_date:date,amount:'0.01',currency:'EUR',mode:'VIREMENT',reference:'QUAL-REFUSED',
   allocations:[{target_type:'FACTURE',target_id:String(invoiceId),amount:'0.01'}]})}),error=>error.code==='PAYMENT_INVOICE_BALANCE_EXCEEDED');
 const allocation=(await pool.query('SELECT id FROM public.paiement_allocations WHERE paiement_id=$1',[payments[0]])).rows[0].id;
 await assert.rejects(()=>pool.query("UPDATE public.paiement_allocations SET advance_vat_snapshot=jsonb_set(advance_vat_snapshot,'{tax_after}','\"99.00\"') WHERE id=$1",[allocation]),error=>error.code==='55000');
 console.log(JSON.stringify({marker:'PROFORMA1268_ADVANCE_CASH_ACCOUNTING_PASS',actualPaymentCommands:2,paymentReplays:2,vatEffects:['13.33','6.67'],
   actualAccountingGeneratedBatches:2,deltaWithoutDuplicateBank:true,bankTotal:'120.00',salesTotal:'0.00',pendingVat:'0.00',collectedVat:'20.00',
   overpaymentRefused:true,immutableCashVat:true,initialInvoiceState:'synthetic issued storage fixture',externalCash:false,uiRecipe:false,businessRecipePassed:false}));
 await require('./customer-refund-rehearsal-1268.cjs')(pool,database,{invoiceId,date,billedClientId:args.billedClientId,mappingId:mapping.id,batches});
 await require('./advance-receipt-after-credit-1268.cjs')(pool,database,{date,billedClientId:args.billedClientId,mappingId:mapping.id});
};
