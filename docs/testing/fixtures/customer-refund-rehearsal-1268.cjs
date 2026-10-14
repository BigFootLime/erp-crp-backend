const assert=require('node:assert/strict');
const {repoPreviewAvoir,repoCreateAvoirDraft}=require('../../../dist/module/facturation/repository/avoir-workflow.repository');
const {freezeAdvanceCreditVat}=require('../../../dist/module/facturation/repository/advance-credit-vat.repository');
const {assertInvoiceCreditWithinBalance,lockInvoiceSettlement}=require('../../../dist/module/facturation/repository/invoice-settlement.repository');
const {avoirPreviewBodySchema,createAvoirDraftBodySchema}=require('../../../dist/module/facturation/validators/workflow.validators');
const {repoPreviewCustomerRefund,repoRegisterCustomerRefund}=require('../../../dist/module/facturation/repository/customer-refund.repository');
const {registerCustomerRefundSchema}=require('../../../dist/module/facturation/validators/customer-refund.validators');
const {createAccountingPreviewSchema}=require('../../../dist/module/accounting-export/accounting-export.validators');
const accounting=require('../../../dist/module/accounting-export/accounting-export.repository');

module.exports=async function qualifyCustomerRefund(pool,database,args){
 assert.match(database,/^cerp_qualify_1268_\d{14}$/);const actor={userId:7,requestId:'qualification-paid-credit-refund',path:'/qualification/refunds'};
 const created=[];
 for(const index of [0,1]){
   const input=avoirPreviewBodySchema.parse({facture_id:args.invoiceId,reason_code:'QUALITY',reason:'Correction de qualification sans flux réel',lines:[{facture_line_id:args.invoiceId,quantity:'0.5'}]});
   const preview=await repoPreviewAvoir(input);assert.equal(preview.totals.total_incl_tax,'60.00');
   const note=await repoCreateAvoirDraft({actor,idempotencyKey:'qual-paid-credit-draft-'+index,input:createAvoirDraftBodySchema.parse({...input,preview_hash:preview.preview_hash})});
   const tx=await pool.connect();try{
     await tx.query('BEGIN');await tx.query('SELECT public.fn_lock_delivery_prepayment_write_1268()');
     assertInvoiceCreditWithinBalance(await lockInvoiceSettlement(tx,args.invoiceId),6000n);
     const frozenVat=await freezeAdvanceCreditVat(tx,args.invoiceId,preview.tax_breakdown);
     assert.equal(frozenVat.entries[0].pending_tax,'0.00');assert.equal(frozenVat.entries[0].collected_tax,'10.00');
     await tx.query("UPDATE public.avoir_source_allocations SET allocation_status='CONSUMED',quantity_credited=quantity_selected,consumed_at=now(),consumed_by=7 WHERE avoir_id=$1",[note.id]);
     // Explicit synthetic issuance state. Normal legal numbering and Finance
     // document issuance are intentionally not claimed by this fixture.
     await tx.query(`UPDATE public.avoir SET statut='ISSUED',legal_number=$2,date_emission=$3,issued_at=now(),issued_by=7,
       immutable_snapshot=$4::jsonb,document_checksum_sha256=repeat('c',64),row_version=row_version+1 WHERE id=$1`,
       [note.id,'QUAL-PAID-CREDIT-NO-SEQUENCE-'+index,args.date,JSON.stringify({synthetic_fiscal_storage_fixture:true,tax_breakdown:preview.tax_breakdown,advance_credit_vat:frozenVat})]);
     await tx.query('COMMIT');
   }catch(error){await tx.query('ROLLBACK');throw error;}finally{tx.release();}
   const refund=await repoPreviewCustomerRefund({avoir_id:note.id});assert.equal(refund.maximum_amount,'60.00');assert.equal(refund.can_refund,true);
   const command={actor,idempotencyKey:'qual-refund-register-'+index,input:registerCustomerRefundSchema.parse({avoir_id:note.id,amount:refund.amount,
     preview_hash:refund.preview_hash,confirm:true,value_date:args.date,booking_date:args.date,mode:'VIREMENT',reference:'QUAL-NO-EXTERNAL-REFUND-'+index,reason:'Remboursement synthétique de qualification'})};
   const paid=await repoRegisterCustomerRefund(command),replay=await repoRegisterCustomerRefund(command);created.push(paid.id);
   assert.equal(replay.id,paid.id);assert.equal(replay.idempotent_replay,true);
   const after=await repoPreviewCustomerRefund({avoir_id:note.id});assert.equal(after.maximum_amount,'0.00');assert.equal(after.can_refund,false);
   await assert.rejects(()=>repoRegisterCustomerRefund({...command,idempotencyKey:'qual-refund-duplicate-'+index}),error=>error.code==='CUSTOMER_REFUND_AMOUNT_EXCEEDED');
   const invoice=(await pool.query('SELECT id FROM public.facture WHERE id=$1',[args.invoiceId])).rows[0];assert.equal(String(invoice.id),String(args.invoiceId));
   const ledger=await accounting.repoCreateAccountingPreview({actor,idempotencyKey:'qual-refund-ledger-'+index,input:createAccountingPreviewSchema.parse({
     mapping_version_id:args.mappingId,period_from:args.date,period_to:args.date,source_types:['PAYMENT','CREDIT_NOTE'],only_unexported:true})});
   assert.equal(ledger.findings.length,0);assert.equal(ledger.source_count,2);
   const valid=await accounting.repoValidateAccountingBatch({batchId:ledger.id,body:{expected_version:ledger.row_version},actor,idempotencyKey:'qual-refund-ledger-valid-'+index});
   const generated=await accounting.repoGenerateAccountingBatch({batchId:ledger.id,body:{expected_version:valid.row_version},actor,idempotencyKey:'qual-refund-ledger-generate-'+index});
   args.batches.push(generated.id);
 }
 const balance=(await pool.query(`SELECT account_number,sum(debit-credit)::numeric(18,2)::text AS balance FROM public.accounting_export_entries
   WHERE batch_id=ANY($1::uuid[]) GROUP BY account_number`,[args.batches])).rows;
 for(const account of ['512QUAL','419100QUAL','445710QUAL','445800QUAL','411QUAL1268'])assert.equal(balance.find(row=>row.account_number===account)?.balance,'0.00');
 assert.equal((await repoPreviewCustomerRefund({avoir_id:(await pool.query('SELECT avoir_id FROM public.customer_refunds WHERE id=$1',[created[1]])).rows[0].avoir_id})).can_refund,false);
 const tx=await pool.connect();try{await tx.query('BEGIN');const invoice=await lockInvoiceSettlement(tx,args.invoiceId);
   assert.equal(invoice.refundableCents,0n);assert.equal(invoice.dueCents,0n);assert.equal(invoice.refundedCents,12000n);assert.equal(invoice.creditedCents,12000n);
 }finally{await tx.query('ROLLBACK');tx.release();}
 await assert.rejects(()=>pool.query('DELETE FROM public.customer_refunds WHERE id=$1',[created[0]]),error=>['42501','55000'].includes(error.code));
 console.log(JSON.stringify({marker:'PROFORMA1268_PAID_CREDIT_REFUND_PASS',paidCreditDrafts:2,correctedSqlCreditConsumption:true,
   advanceVatCorrections:['10.00','10.00'],actualRefundCommands:2,refundReplays:2,refundTotal:'120.00',guidedCashOrigins:true,
   generatedCreditRefundBatches:2,bankAfterFullRefund:'0.00',advancesAfterFullRefund:'0.00',vatAfterFullRefund:'0.00',customerBalance:'0.00',
   duplicateRefundRefused:true,refundEvidenceImmutable:true,creditFiscalIssuance:'explicit simulated storage',externalCash:false,uiRecipe:false,businessRecipePassed:false}));
};
