const assert=require('node:assert/strict');
const {readDeliveryPrepaymentBoundary,assertDeliveryPrepaymentBoundary,lockDeliveryPrepaymentSources}=
  require('../../../dist/module/livraisons/repository/delivery-prepayment-boundary.repository');

/** Synthetic DRAFT BL rows qualify SQL joins/guards; no stock exit or shipment. */
module.exports=async function qualifyDeliveryPrepaymentSql(pool,database,physicalClientId){
  assert.match(database,/^cerp_qualify_1268_\d{14}$/);
  const tx=await pool.connect();
  const bl='12683000-0000-4000-8000-000000000001',line='12683000-0000-4000-8000-000000000002';
  try{
    await tx.query('BEGIN');
    const article=(await tx.query(`INSERT INTO public.articles(id,root_article_id,code,designation,article_type,article_category,family_code,version_number,plan_index,status)
      VALUES('12683000-0000-4000-8000-000000000004','12683000-0000-4000-8000-000000000004',
        'QUAL1268-READ-BL','Article fictif de qualification BL','PURCHASED','achat','ACH',1,1,'VALIDE') RETURNING id::text`)).rows[0].id;
    await tx.query(`INSERT INTO public.bon_livraison(id,numero,client_id,commande_id,affaire_id,statut,created_by)
      VALUES($1,'QUAL1268-BL-DRAFT',$2,1268001,1268001,'DRAFT',7)`,[bl,physicalClientId]);
    await tx.query(`INSERT INTO public.bon_livraison_ligne(id,bon_livraison_id,ordre,designation,quantite,commande_ligne_id)
      VALUES($1,$2,1,'Ligne fictive pour contrôle proforma',100,1268001)`,[line,bl]);
    await tx.query(`INSERT INTO public.bon_livraison_ligne_allocations(bon_livraison_ligne_id,article_id,quantite,commande_ligne_affaire_allocation_id)
      VALUES($1,$2,100,1268001)`,[line,article]);
    const initial=await readDeliveryPrepaymentBoundary(tx,bl);
    assert.equal(initial.affairs.length,1);assert.equal(initial.affairs[0].source_unchanged,true);
    assert.equal(initial.affairs[0].billing_parts.find(part=>part.company_name==='Qualification société A').paidAmount,'80.00');
    assert.ok(initial.blockers.some(blocker=>blocker.code==='DELIVERY_PROFORMA_NOT_PAID'));
    await assert.rejects(()=>assertDeliveryPrepaymentBoundary(tx,bl),error=>error.code==='DELIVERY_PREPAYMENT_BLOCKED');
    await lockDeliveryPrepaymentSources(tx,bl);
    await tx.query('UPDATE public.commande_ligne SET prix_unitaire_ht=12 WHERE id=1268001');
    assert.ok((await readDeliveryPrepaymentBoundary(tx,bl)).blockers.some(blocker=>blocker.code==='DELIVERY_PROFORMA_SOURCE_CHANGED'));
    // A DRAFT can still repair its financial selection; READY/SHIPPED cannot.
    await tx.query(`UPDATE public.delivery_affair_prepayment_terms SET requirement='NOT_REQUIRED',row_version=row_version+1,
      decision_reason='Qualification BL hors proforma',updated_by=7,correlation_id='12683000-0000-4000-8000-000000000099'
      WHERE allocation_id=1268002`);
    const second='12683000-0000-4000-8000-000000000003';
    await tx.query(`INSERT INTO public.bon_livraison_ligne(id,bon_livraison_id,ordre,designation,quantite,commande_ligne_id)
      VALUES($1,$2,2,'Seconde affaire fictive hors proforma',10,1268002)`,[second,bl]);
    await tx.query(`INSERT INTO public.bon_livraison_ligne_allocations(bon_livraison_ligne_id,article_id,quantite,commande_ligne_affaire_allocation_id)
      VALUES($1,$2,10,1268002)`,[second,article]);
    assert.ok((await readDeliveryPrepaymentBoundary(tx,bl)).blockers.some(blocker=>blocker.code==='MIXED_DELIVERY_PROFORMA'));
    await tx.query(`INSERT INTO public.bon_livraison_ligne(bon_livraison_id,ordre,designation,quantite,commande_ligne_id)
      VALUES($1,3,'Ligne fictive non reliée à une affaire',1,1268002)`,[bl]);
    assert.ok((await readDeliveryPrepaymentBoundary(tx,bl)).blockers.some(blocker=>blocker.code==='DELIVERY_PREPAYMENT_LINE_SOURCE_REQUIRED'));
    console.log(JSON.stringify({marker:'PROFORMA1268_BL_SQL_GUARDS_PASS',scope:'synthetic DRAFT joins and locks; rolled back',
      checks:['allocated cash evidence','all billed companies covered','source price revision','same proforma grouping','unbound line refusal','source lock order'],
      stockMovementCreated:false,blShipped:false,businessRecipePassed:false}));
  }finally{await tx.query('ROLLBACK');tx.release();}
};
