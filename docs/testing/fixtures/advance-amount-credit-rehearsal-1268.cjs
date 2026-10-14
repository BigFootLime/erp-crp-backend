const assert=require('node:assert/strict');
const {allocateDocumentTaxBreakdown}=require('../../../dist/module/facturation/domain/document-tax-breakdown');
const {repoPreviewAvoir,repoCreateAvoirDraft,repoListAvoirEligibleLines}=require('../../../dist/module/facturation/repository/avoir-workflow.repository');
const {freezeAdvanceCreditVat}=require('../../../dist/module/facturation/repository/advance-credit-vat.repository');
const {avoirPreviewBodySchema,createAvoirDraftBodySchema}=require('../../../dist/module/facturation/validators/workflow.validators');

module.exports=async function qualifyAdvanceAmounts(pool,database,args){
 assert.match(database,/^cerp_qualify_1268_\d{14}$/);
 const invoiceId=1268581,actor={userId:7,requestId:'qualification-advance-amount',path:'/qualification/advance-amount'};
 const line={quantity:'1.000',unit_price_ex_tax:'100.0000',discount_percent:'0.0000',tax_rate_percent:'20.0000',
  total_ex_tax:'100.00',tax_amount:'20.00',total_incl_tax:'120.00'};
 const model=allocateDocumentTaxBreakdown({lines:[{ratePercent:'20',net:'100.00',tax:'20.00'}],totalExTax:'100.00',totalTax:'20.00',totalInclTax:'120.00'});
 const tx=await pool.connect();try{
  await tx.query('BEGIN');
  await tx.query(`INSERT INTO public.facture(id,numero,client_id,statut,total_ht,total_tax,total_ttc,currency,date_emission)
   VALUES($1,'QUAL-AMOUNT-ADVANCE',$2,'DRAFT',100,20,120,'EUR','2026-10-14')`,[invoiceId,args.billedClientId]);
  await tx.query(`INSERT INTO public.facture_ligne(id,facture_id,ordre,designation,quantite,prix_unitaire_ht,taux_tva,total_ht,tax_amount,total_ttc)
   VALUES($1,$1,1,'Acompte monétaire de qualification',1,100,20,100,20,120)`,[invoiceId]);
  await tx.query(`INSERT INTO public.facture_source_allocations(id,facture_id,facture_ligne_id,source_type,source_id,source_line_id,
   quantity_selected,amount_ex_tax,amount_incl_tax,source_snapshot,rule_code,created_by)
   VALUES('12685810-0000-4000-8000-000000000001',$1,$1,'DEPOSIT',$2,$3,1,100,120,
   '{"synthetic_fiscal_storage_fixture":true}','PROFORMA_DEPOSIT_V1',7)`,[invoiceId,args.proformaId,args.partId]);
  await tx.query(`INSERT INTO public.proforma_deposit_sources(facture_source_allocation_id,proforma_billing_part_id,created_by,correlation_id)
   VALUES('12685810-0000-4000-8000-000000000001',$1,7,'12685810-0000-4000-8000-000000000099')`,[args.partId]);
  await tx.query("UPDATE public.facture_source_allocations SET allocation_status='CONSUMED',quantity_consumed=1 WHERE facture_id=$1",[invoiceId]);
  // Explicit fixture of an already issued original, not normal fiscal issuance.
  await tx.query(`UPDATE public.facture SET statut='ISSUED',document_status='ISSUED',legal_number='QUAL-AMOUNT-NO-SEQUENCE',issued_at=now(),issued_by=7,
   immutable_snapshot=$2::jsonb,document_checksum_sha256=repeat('e',64),row_version=2 WHERE id=$1`,
   [invoiceId,JSON.stringify({invoice_type_code:386,lines:[line],tax_breakdown:model,synthetic_fiscal_storage_fixture:true})]);
  await tx.query('COMMIT');
 }catch(error){await tx.query('ROLLBACK');throw error;}finally{tx.release();}
 const entries=[];
 for(const [index,amount,tax,gross] of [[0,'33.33','6.67','40.00'],[1,'33.33','6.66','39.99'],[2,'33.34','6.67','40.01']]){
  const input=avoirPreviewBodySchema.parse({facture_id:invoiceId,reason_code:'COMMERCIAL_GESTURE',reason:'Correction monétaire de qualification',
   lines:[{facture_line_id:invoiceId,advance_amount_ex_tax:amount}]});
  const preview=await repoPreviewAvoir(input);
  assert.equal(preview.totals.total_ex_tax,amount);assert.equal(preview.totals.total_tax,tax);assert.equal(preview.totals.total_incl_tax,gross);
  const command={actor,idempotencyKey:'qual-advance-amount-'+index,input:createAvoirDraftBodySchema.parse({...input,preview_hash:preview.preview_hash})};
  const note=await repoCreateAvoirDraft(command),replay=await repoCreateAvoirDraft(command);
  assert.equal(replay.id,note.id);assert.equal(replay.idempotent_replay,true);
  const stored=(await pool.query(`SELECT source_type,quantity_selected::text,amount_ttc::text FROM public.avoir_source_allocations WHERE avoir_id=$1`,[note.id])).rows[0];
  assert.equal(stored.source_type,'INVOICE_AMOUNT');assert.equal(stored.quantity_selected,'0.000');assert.equal(stored.amount_ttc,gross);
  if(index===0){
   const excessInput={...input,lines:[{facture_line_id:invoiceId,advance_amount_ex_tax:'100.00'}]};
   const excessPreview=await repoPreviewAvoir(excessInput);
   await assert.rejects(()=>repoCreateAvoirDraft({actor,idempotencyKey:'qual-amount-draft-overbook',
    input:{...excessInput,preview_hash:excessPreview.preview_hash}}),e=>e.code==='AVOIR_ADVANCE_AMOUNT_CONFLICT');
   await assert.rejects(()=>pool.query('UPDATE public.avoir_source_allocations SET quantity_selected=0.001 WHERE avoir_id=$1',[note.id]),
    e=>e.code==='23514'&&e.message.includes('zero physical consumption'));
  }
  const issue=await pool.connect();try{
   await issue.query('BEGIN');await issue.query('SELECT public.fn_lock_delivery_prepayment_write_1268()');
   const vat=await freezeAdvanceCreditVat(issue,invoiceId,preview.tax_breakdown);
   assert.equal(vat.entries[0].pending_tax,tax);assert.equal(vat.entries[0].collected_tax,'0.00');
   await issue.query("UPDATE public.avoir_source_allocations SET allocation_status='CONSUMED',quantity_credited=quantity_selected,consumed_at=now(),consumed_by=7 WHERE avoir_id=$1",[note.id]);
   await issue.query(`UPDATE public.avoir SET statut='ISSUED',legal_number=$2,issued_at=now(),issued_by=7,immutable_snapshot=$3::jsonb,
    document_checksum_sha256=repeat('f',64),row_version=row_version+1 WHERE id=$1`,[note.id,'QUAL-AMOUNT-CREDIT-'+index,
    JSON.stringify({synthetic_fiscal_storage_fixture:true,lines:preview.lines,tax_breakdown:preview.tax_breakdown,advance_credit_vat:vat})]);
   await issue.query('COMMIT');
  }catch(error){await issue.query('ROLLBACK');throw error;}finally{issue.release();}
  entries.push({net:amount,tax,gross});
 }
 const eligible=await repoListAvoirEligibleLines(invoiceId);
 assert.equal(eligible.lines[0].eligible,false);assert.equal(eligible.lines[0].amount_remaining_ex_tax,'0.00');
 await assert.rejects(()=>repoPreviewAvoir({facture_id:invoiceId,reason_code:'OTHER',reason:'Dépassement interdit',
  lines:[{facture_line_id:invoiceId,advance_amount_ex_tax:'0.01'}]}),e=>e.code==='AVOIR_AMOUNT_EXCEEDS_REMAINING');
 const sums=(await pool.query(`SELECT sum(quantity_credited)::text AS physical,sum(amount_ttc)::text AS money
  FROM public.avoir_source_allocations WHERE facture_id=$1 AND allocation_status='CONSUMED'`,[invoiceId])).rows[0];
 assert.equal(sums.physical,'0.000');assert.equal(sums.money,'120.00');
 console.log(JSON.stringify({marker:'PROFORMA1268_MONETARY_ADVANCE_CREDITS_PASS',actualDraftCommands:3,replays:3,entries,
  physicalQuantityCredited:'0.000',netCredited:'100.00',taxCredited:'20.00',grossCredited:'120.00',excessRefused:true,
  concurrentDraftOverbookingRefused:true,physicalQuantityTamperingRefused:true,
  originalFiscalIssuance:'explicit simulated storage',creditFiscalIssuance:'explicit simulated storage',uiRecipe:false,businessRecipePassed:false}));
};
