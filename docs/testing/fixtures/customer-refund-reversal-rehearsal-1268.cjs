const assert=require('node:assert/strict');
const {repoPreviewCustomerRefundReversal,repoReverseCustomerRefund}=require('../../../dist/module/facturation/repository/customer-refund-reversal.repository');
const {repoPreviewCustomerRefund,repoRegisterCustomerRefund}=require('../../../dist/module/facturation/repository/customer-refund.repository');
const {reverseCustomerRefundSchema,registerCustomerRefundSchema}=require('../../../dist/module/facturation/validators/customer-refund.validators');
const {createAccountingPreviewSchema}=require('../../../dist/module/accounting-export/accounting-export.validators');
const {lockInvoiceSettlement}=require('../../../dist/module/facturation/repository/invoice-settlement.repository');
const accounting=require('../../../dist/module/accounting-export/accounting-export.repository');

module.exports=async function qualifyRefundReversal(pool,database,args){
 assert.match(database,/^cerp_qualify_1268_\d{14}$/);
 const actor={userId:7,requestId:'qualification-refund-reversal',path:'/qualification/refund-reversals'};
 const origin=(await pool.query('SELECT id,avoir_id FROM public.customer_refunds WHERE id=$1',[args.refundId])).rows[0];
 assert.ok(origin);
 async function reverse(refundId,date,key){
  const preview=await repoPreviewCustomerRefundReversal({refund_id:refundId});assert.equal(preview.amount,'60.00');assert.equal(preview.can_reverse,true);
  const command={actor,idempotencyKey:key,input:reverseCustomerRefundSchema.parse({refund_id:refundId,preview_hash:preview.preview_hash,
   confirm:true,value_date:date,booking_date:date,reference:'QUAL-CORRECTION-NO-BANK-TRANSFER',reason:'Correction synthétique du remboursement saisi par erreur'})};
  const correction=await repoReverseCustomerRefund(command),replay=await repoReverseCustomerRefund(command);
  assert.equal(replay.id,correction.id);assert.equal(replay.idempotent_replay,true);
  assert.equal((await repoPreviewCustomerRefundReversal({refund_id:refundId})).can_reverse,false);
  await assert.rejects(()=>repoReverseCustomerRefund({...command,idempotencyKey:key+'-duplicate'}),error=>error.code==='CUSTOMER_REFUND_ALREADY_REVERSED');
  return correction;
 }
 async function refund(date,key){
  const preview=await repoPreviewCustomerRefund({avoir_id:origin.avoir_id});assert.equal(preview.maximum_amount,'60.00');assert.equal(preview.can_refund,true);
  return repoRegisterCustomerRefund({actor,idempotencyKey:key,input:registerCustomerRefundSchema.parse({avoir_id:origin.avoir_id,amount:'60.00',
   preview_hash:preview.preview_hash,confirm:true,value_date:date,booking_date:date,mode:'VIREMENT',reference:'QUAL-REPLACEMENT-NO-BANK-TRANSFER',
   reason:'Remboursement synthétique après correction du fait précédent'})});
 }
 async function exportAt(date,mappingId,key,types){
  const preview=await accounting.repoCreateAccountingPreview({actor,idempotencyKey:key+'-preview',input:createAccountingPreviewSchema.parse({
   mapping_version_id:mappingId,period_from:date,period_to:date,source_types:types,only_unexported:true})});
  assert.equal(preview.findings.length,0);
  const valid=await accounting.repoValidateAccountingBatch({actor,batchId:preview.id,body:{expected_version:preview.row_version},idempotencyKey:key+'-valid'});
  const generated=await accounting.repoGenerateAccountingBatch({actor,batchId:preview.id,body:{expected_version:valid.row_version},idempotencyKey:key+'-generate'});
  args.batches.push(generated.id);return generated;
 }
 const originalPosting=(await pool.query(`SELECT claim.batch_id,entry.journal_code,entry.account_number,entry.third_party_account,entry.currency,
  entry.debit::numeric(18,2)::text,entry.credit::numeric(18,2)::text,entry.axes
  FROM public.accounting_export_source_claims claim JOIN public.accounting_export_entries entry ON entry.batch_id=claim.batch_id
   AND entry.source_type=claim.source_type AND entry.source_id=claim.source_id
  WHERE claim.source_type='CUSTOMER_REFUND' AND claim.source_id=$1 AND claim.released_at IS NULL ORDER BY entry.line_no`,[args.refundId])).rows;
 assert.equal(originalPosting.length,2);
 const oldMapping=(await accounting.repoListAccountingMappings(true)).find(item=>item.id===args.mappingId);
 const changed=await accounting.repoCreateAccountingMapping({actor,idempotencyKey:'qual-reversal-changed-mapping',input:{version_code:'QUAL-REVERSAL-CHANGED',adapter_code:'GENERIC_DELIMITED_V1',
  effective_from:'2026-10-14',effective_to:'2026-10-14',activate:true,config:{...oldMapping.config,bank_account_by_mode:{VIREMENT:'512CHANGED'},bank_journal_by_mode:{VIREMENT:'CHANGED'},default_axes:{SITE:'CHANGED'}}}});
 const correction=await reverse(args.refundId,'2026-10-14','qual-original-refund-reverse');
 const tx=await pool.connect();try{await tx.query('BEGIN');const invoice=await lockInvoiceSettlement(tx,args.invoiceId);
  assert.equal(invoice.refundableCents,6000n);assert.equal(invoice.refundedCents,6000n);
 }finally{await tx.query('ROLLBACK');tx.release();}
 const inverse=await exportAt('2026-10-14',changed.id,'qual-retained-inverse',['CUSTOMER_REFUND_REVERSAL']);
 const inverseLines=(await pool.query(`SELECT journal_code,account_number,third_party_account,currency,
  debit::numeric(18,2)::text,credit::numeric(18,2)::text,axes FROM public.accounting_export_entries WHERE batch_id=$1 ORDER BY line_no`,[inverse.id])).rows;
 assert.deepEqual(inverseLines,originalPosting.map(({batch_id,...line})=>({...line,debit:line.credit,credit:line.debit})));
 const originalBatch=await accounting.repoGetAccountingBatch(originalPosting[0].batch_id);
 await assert.rejects(()=>accounting.repoCancelAccountingBatch({actor,batchId:originalBatch.id,body:{expected_version:originalBatch.row_version,reason:'Cannot release original refund evidence'},
  idempotencyKey:'qual-refund-origin-cancel'}),error=>error.code==='ACCOUNTING_REFUND_ORIGINAL_RETAINED');
 await assert.rejects(()=>pool.query("UPDATE public.accounting_export_source_claims SET released_at=now(),released_by=7,release_reason='Raw qualification release' WHERE batch_id=$1 AND source_type='CUSTOMER_REFUND' AND source_id=$2",[originalBatch.id,args.refundId]),
  error=>error.code==='23514'&&error.message.includes('REFUND-REVERSAL-1268'));
 await assert.rejects(()=>pool.query('DELETE FROM public.customer_refund_reversals WHERE id=$1',[correction.id]),error=>['42501','55000'].includes(error.code));
 const restoredMapping=await accounting.repoCreateAccountingMapping({actor,idempotencyKey:'qual-reversal-restored-mapping',input:{version_code:'QUAL-REVERSAL-RESTORED',adapter_code:'GENERIC_DELIMITED_V1',
  effective_from:'2026-10-15',activate:true,config:oldMapping.config}});
 const replacement=await refund('2026-10-15','qual-refund-replacement-before-export');
 await reverse(replacement.id,'2026-10-15','qual-unexported-refund-reverse');
 const paired=await exportAt('2026-10-15',restoredMapping.id,'qual-paired-inverse',['PAYMENT']);assert.equal(paired.source_count,2);
 const pairedBalances=(await pool.query('SELECT account_number,sum(debit-credit)::numeric(18,2)::text AS balance FROM public.accounting_export_entries WHERE batch_id=$1 GROUP BY account_number',[paired.id])).rows;
 assert.ok(pairedBalances.every(row=>row.balance==='0.00'));
 await refund('2026-10-16','qual-refund-replacement-final');await exportAt('2026-10-16',restoredMapping.id,'qual-replacement-final-ledger',['PAYMENT']);
 const balances=(await pool.query('SELECT account_number,sum(debit-credit)::numeric(18,2)::text AS balance FROM public.accounting_export_entries WHERE batch_id=ANY($1::uuid[]) GROUP BY account_number',[args.batches])).rows;
 assert.ok(balances.every(row=>row.balance==='0.00'));
 assert.equal((await pool.query('SELECT sum(amount_ttc)::numeric(18,2)::text AS amount FROM public.customer_refunds_effective_1268 WHERE facture_id=$1',[args.invoiceId])).rows[0].amount,'120.00');
 assert.equal((await pool.query('SELECT count(*)::int AS count FROM public.customer_refunds WHERE facture_id=$1',[args.invoiceId])).rows[0].count,4);
 console.log(JSON.stringify({marker:'PROFORMA1268_REFUND_REVERSALS_PASS',actualCorrectionCommands:2,replays:2,duplicatesRefused:2,
  correctedRefundAmount:'60.00',cashBudgetRestored:true,oldAccountsJournalAxesRetained:true,originalExportCannotBeReleased:true,
  pairedUnexportedRefundAndCorrection:true,originalRefundFactsRetained:4,effectiveRefundTotal:'120.00',finalLedgerBalances:'all zero',
  additionalVatCorrection:false,externalCash:false,uiRecipe:false,businessRecipePassed:false}));
};
