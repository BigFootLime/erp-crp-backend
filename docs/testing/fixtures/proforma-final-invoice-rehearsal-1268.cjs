const assert = require('node:assert/strict');
const {readProformaFinalInvoiceAffairs,bindProformaFinalInvoiceSourceTx} = require('../../../dist/module/facturation/repository/proforma-final-invoice.repository');
const {planProformaFinalInvoice} = require('../../../dist/module/facturation/domain/proforma-final-invoice');
const {repoListEligibleFactureSources,repoPreviewFacture} = require('../../../dist/module/facturation/repository/facture-workflow.repository');

/** Storage fixtures, not real shipment, fiscal issuance, cash or UI acceptance. */
module.exports = async function qualifyFinalInvoiceSources(pool, database, args) {
  assert.match(database, /^cerp_qualify_1268_\d{14}$/);
  const bl1='12684000-0000-4000-8000-000000000001',line1='12684000-0000-4000-8000-000000000002';
  const bl2='12684000-0000-4000-8000-000000000003',line2='12684000-0000-4000-8000-000000000004';
  const article='12684000-0000-4000-8000-000000000005';
  const seed=await pool.connect();
  try {
    await seed.query('BEGIN');
    await seed.query(`INSERT INTO public.articles(id,root_article_id,code,designation,article_type,article_category,family_code,version_number,plan_index,status)
      VALUES($1,$1,'QUAL1268-FINAL','Article fictif final multisociétés','PURCHASED','achat','ACH',1,1,'VALIDE')`,[article]);
    for (const [bl,line,quantity] of [[bl1,line1,12],[bl2,line2,50]]) {
      await seed.query(`INSERT INTO public.bon_livraison(id,numero,client_id,commande_id,affaire_id,statut,created_by)
        VALUES($1,$2,$3,1268001,1268001,'SHIPPED',7)`,[bl,'QUAL1268-SYNTHETIC-'+quantity,args.physicalClientId]);
      await seed.query(`INSERT INTO public.bon_livraison_ligne(id,bon_livraison_id,ordre,designation,quantite,commande_ligne_id)
        VALUES($1,$2,1,'Ligne synthétique pour quotas finaux',$3,1268001)`,[line,bl,quantity]);
      for (const lotQuantity of quantity===12 ? [8,4] : [50]) {
        await seed.query(`INSERT INTO public.bon_livraison_ligne_allocations(bon_livraison_ligne_id,article_id,quantite,commande_ligne_affaire_allocation_id)
          VALUES($1,$2,$3,1268001)`,[line,article,lotQuantity]);
      }
    }
    await seed.query('COMMIT');
  } catch(error) { await seed.query('ROLLBACK'); throw error; } finally { seed.release(); }
  const first=await readProformaFinalInvoiceAffairs(pool,[line1],args.billedClientId);
  assert.equal(first.length,1);assert.equal(first[0].delivered_quantity,'12.000');
  assert.equal(first[0].part_quantity,'30.000');assert.equal(first[0].unit_price_ex_tax,'11.0000');
  const selected=planProformaFinalInvoice({affairs:first,quantity:'12.000',sourceQuantity:'12.000',remainingSourceQuantity:'12.000',billedClientId:args.billedClientId,currency:'EUR'});
  assert.equal(selected.contributions.length,1);

  async function reserve(invoiceId,sourceId,bl,line,quantity,partId=args.partId,bind=true) {
    const tx=await pool.connect();
    try {
      await tx.query('BEGIN');
      await tx.query('SELECT public.fn_lock_delivery_prepayment_write_1268()');
      await tx.query(`INSERT INTO public.facture(id,numero,client_id,statut,total_ht,total_tax,total_ttc,currency)
        VALUES($1,$2,$3,'DRAFT',$4,$5,$6,'EUR')`,[invoiceId,'QUAL-SYNTHETIC-FINAL-'+invoiceId,args.billedClientId,quantity*11,quantity*2.2,quantity*13.2]);
      await tx.query(`INSERT INTO public.facture_ligne(id,facture_id,designation,quantite,prix_unitaire_ht,remise_ligne,taux_tva,total_ht,tax_amount,total_ttc)
        VALUES($1,$1,'Finale synthétique isolée',$2,11,0,20,$3,$4,$5)`,[invoiceId,quantity,quantity*11,quantity*2.2,quantity*13.2]);
      await tx.query(`INSERT INTO public.facture_source_allocations(id,facture_id,facture_ligne_id,source_type,source_id,source_line_id,quantity_selected,amount_ex_tax,amount_incl_tax,source_snapshot,rule_code,created_by)
        VALUES($1,$2,$2,'DELIVERY_LINE',$3,$4,$5,$6,$7,'{"synthetic_final_storage_fixture":true}','PROFORMA_FINAL_QUANTITY_V1',7)`,
        [sourceId,invoiceId,bl,line,quantity,quantity*11,quantity*13.2]);
      if(bind) await bindProformaFinalInvoiceSourceTx(tx,{sourceAllocationId:sourceId,contributions:[{billing_part_id:partId,allocation_id:'1268001',quantity:quantity.toFixed(3)}],actorId:7,correlationId:'12684000-0000-4000-8000-000000000099'});
      await tx.query('COMMIT');
      return invoiceId;
    } catch(error) { await tx.query('ROLLBACK'); throw error; } finally { tx.release(); }
  }
  const source1='12684100-0000-4000-8000-000000000001';
  await reserve(1268401,source1,bl1,line1,12);
  assert.equal((await readProformaFinalInvoiceAffairs(pool,[line1],args.billedClientId))[0].quantity_already_selected,'12.000');
  const own=await readProformaFinalInvoiceAffairs(pool,[line1],args.billedClientId,1268401);
  assert.equal(own[0].quantity_already_selected,'0.000');assert.equal(own[0].part_already_selected,'0.000');
  const next=await readProformaFinalInvoiceAffairs(pool,[line2],args.billedClientId);
  assert.equal(next[0].part_already_selected,'12.000');
  const nextPlan=planProformaFinalInvoice({affairs:next,quantity:'18.000',sourceQuantity:'50.000',remainingSourceQuantity:'50.000',billedClientId:args.billedClientId,currency:'EUR'});
  assert.equal(nextPlan.capacity,'18.000');
  const listed=await repoListEligibleFactureSources({client_id:args.billedClientId,q:'',page:1,pageSize:25});
  assert.equal(listed.total,2);
  assert.equal(listed.items.find(item=>item.source_line_id===line1).quantity_remaining,'0.000');
  assert.equal(listed.items.find(item=>item.source_line_id===line2).quantity_remaining,'18.000');
  assert.equal(listed.items.find(item=>item.source_line_id===line2).physical_client_id,args.physicalClientId);
  const previewInput={client_id:args.billedClientId,currency:'EUR',sources:[{source_type:'DELIVERY_LINE',source_id:bl2,source_line_id:line2,quantity:'18.000'}],
    global_discount_percent:'0.0000',due_dates:[{due_date:'2026-11-30',label:'Échéance'}],
    regulatory:{billing_frame_code:'B1',operation_category:'GOODS',transaction_scope:'FR_PRIVATE_B2B'},internal_comment:null,customer_text:null};
  const quote=await repoPreviewFacture(previewInput);
  assert.equal(quote.lines[0].unit_price_ex_tax,'11.0000');
  assert.equal(quote.lines[0].total_incl_tax,'237.60');
  assert.equal(quote.blockers.some(blocker=>blocker.code==='SOURCE_CLIENT_MISMATCH'),false);
  // Only the commercial issuer is seeded. Legal regulatory prerequisites
  // intentionally remain incomplete; this does not qualify fiscal issuance.
  assert.ok(quote.blockers.length>0);
  await pool.query('UPDATE public.commande_ligne SET prix_unitaire_ht=12 WHERE id=1268001');
  assert.equal((await repoPreviewFacture(previewInput)).lines[0].unit_price_ex_tax,'11.0000');
  const tooMany=await repoPreviewFacture({...previewInput,sources:[{...previewInput.sources[0],quantity:'19.000'}]});
  assert.ok(tooMany.blockers.some(blocker=>blocker.code==='PROFORMA_FINAL_QUANTITY_EXCEEDED'));
  await assert.rejects(()=>reserve(1268402,'12684100-0000-4000-8000-000000000002',bl2,line2,19),e=>e.code==='23514');
  await assert.rejects(()=>reserve(1268403,'12684100-0000-4000-8000-000000000003',bl2,line2,1,args.partId,false),e=>e.code==='23514');
  const otherPart=(await pool.query(`SELECT part.id FROM public.proforma_billing_parts part JOIN public.proforma_affair_lines line ON line.id=part.proforma_line_id
    WHERE line.proforma_id=$1 AND part.id<>$2`,[args.proformaId,args.partId])).rows[0].id;
  await assert.rejects(()=>reserve(1268404,'12684100-0000-4000-8000-000000000004',bl2,line2,1,otherPart),e=>e.code==='23514');
  const concurrent=await Promise.allSettled([
    reserve(1268405,'12684100-0000-4000-8000-000000000005',bl2,line2,18),
    reserve(1268406,'12684100-0000-4000-8000-000000000006',bl2,line2,18),
  ]);
  assert.equal(concurrent.filter(item=>item.status==='fulfilled').length,1);
  assert.equal(concurrent.find(item=>item.status==='rejected').reason.code,'23514');
  assert.equal((await readProformaFinalInvoiceAffairs(pool,[line2],args.billedClientId))[0].part_already_selected,'30.000');
  await assert.rejects(()=>pool.query('DELETE FROM public.proforma_final_invoice_sources WHERE facture_source_allocation_id=$1',[source1]),e=>e.code==='42501');
  const reused=await pool.connect();
  try {
    await reused.query('BEGIN');
    await reused.query(`UPDATE public.facture_source_allocations SET allocation_status='REVERSED' WHERE id=$1`,[source1]);
    assert.equal((await readProformaFinalInvoiceAffairs(reused,[line1],args.billedClientId))[0].quantity_already_selected,'0.000');
    assert.equal((await readProformaFinalInvoiceAffairs(reused,[line1],args.billedClientId))[0].part_already_selected,'18.000');
    assert.equal((await reused.query('SELECT count(*)::int AS n FROM public.proforma_final_invoice_sources WHERE facture_source_allocation_id=$1',[source1])).rows[0].n,1);
  } finally { await reused.query('ROLLBACK'); reused.release(); }
  console.log(JSON.stringify({marker:'PROFORMA1268_FINAL_COMPANY_QUOTAS_PASS',physicalRecipientDifferent:true,
    partialDeliveredQuantities:[12,50],companyQuota:30,concurrentBudget:'one accepted, one rejected',
    ownInvoiceExcludedOnce:true,missingLineageRefused:true,wrongCompanyRefused:true,historyRetained:true,
    actualListAndPreview:true,frozenPriceRetained:true,
    fiscalInvoices:'synthetic storage fixtures only',realShipment:false,realCash:false,businessRecipePassed:false}));
};
