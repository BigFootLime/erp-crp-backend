/* Mutations are confined to the literal restored fixture DB; real repositories, no mocks. */
const assert=require('node:assert/strict'),path=require('node:path'),{randomUUID}=require('node:crypto');
const root=process.env.CATALOGUE_MINIMUM_COMPILED_ROOT;
if(!root)throw new Error('Explicit isolated compiled fixture required');
const pool=require(path.join(root,'config/database.js')).default;
const {readSubcontractProcurement,prepareSubcontractProcurement}=require(path.join(root,'module/subcontract/subcontract-procurement.repository.js'));
const {assertCatalogueMinimumsTx,readCatalogueOrderQuantityTx,readCatalogueLinePriceTx}=require(path.join(root,'module/commande-fournisseur/repository/catalogue-line-pricing.repository.js'));
const {assertSubcontractPurchaseReadyTx}=require(path.join(root,'module/commande-fournisseur/repository/subcontract-purchase.repository.js'));
const {repoUpdateLigne}=require(path.join(root,'module/commande-fournisseur/repository/commande-fournisseur.repository.js'));
let passed=0;const pass=label=>{passed++;console.log('PASS: '+label);};
async function main(){
  assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name,'catalogue_minimum_1265');
  const initial=await readSubcontractProcurement(95);assert.equal(initial.of.number,'OF-2026-001238');assert.equal(initial.of.quantity,20);
  assert.equal(initial.drafts.length,0);
  const purchase=initial.purchases.find(p=>/nitruration/i.test(p.designation??p.nom??''));
  assert(purchase);const operation=initial.operations.find(o=>o.phase===30);
  const offer=initial.offers.find(o=>o.articleId===purchase.article_id&&o.supplierName==='TEST – Rhône Traitements');
  assert(operation&&offer);assert.equal(offer.minimumQuantity,4);
  const origins=['LOT-2026-001253','LOT-2026-001254'].map(label=>initial.origins.find(o=>o.label===label));assert(origins.every(Boolean));
  const actor=(await pool.query('SELECT created_by FROM public.ordres_fabrication WHERE id=95')).rows[0].created_by;
  const audit={user_id:actor,ip:null,user_agent:'isolated MOQ recipe fixture',device_type:null,os:null,browser:null,path:'/isolated/catalogue-minimum1265',page_key:'production',client_session_id:null};
  const make=(current,rows)=>({idempotencyKey:randomUUID(),expectedVersion:current.version,purchaseId:purchase.id,operationId:operation.id,
    catalogueId:offer.id,destinationId:current.destinations.find(d=>d.name==='NEW-PF').id,due:'2026-10-15',rows,reason:'Recette isolée des deux origines matière pour la nitruration.'});
  const body=make(initial,[{originId:origins[0].id,quantity:18},{originId:origins[1].id,quantity:2}]);
  const [created,concurrent]=await Promise.all([prepareSubcontractProcurement(95,body,audit),prepareSubcontractProcurement(95,body,audit)]);
  assert.deepEqual(concurrent.commands,created.commands);assert.equal(created.commands.length,1);
  const orderId=created.commands[0].id;
  const lines=(await pool.query(`SELECT l.id::text,l.quantite::float8 AS quantity,l.catalogue_pricing_snapshot->>'moq' AS minimum,p.material_origin_id::text AS origin
    FROM public.commande_fournisseur_ligne l JOIN public.subcontract_purchase_origins p ON p.line_id=l.id WHERE l.commande_id=$1::uuid ORDER BY l.position`,[orderId])).rows;
  assert.deepEqual(lines.map(l=>l.quantity),[18,2]);assert(lines.every(l=>l.minimum==='4'));assert.deepEqual(lines.map(l=>l.origin),origins.map(o=>o.id));
  pass('real subcontract preparation creates exactly one draft, two origin lines18+2, and keeps the quotedMOQ4');
  pass('concurrent confirmation uses one idempotent order, without duplicate lines');
  assert.deepEqual((await prepareSubcontractProcurement(95,body,audit)).commands,created.commands);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM public.commande_fournisseur_ligne WHERE commande_id=$1::uuid',[orderId])).rows[0].count,2);
  pass('replay does not create a second order or another origin');
  const tx=await pool.connect();try{await tx.query('BEGIN');await assertCatalogueMinimumsTx(tx,orderId);await assertSubcontractPurchaseReadyTx(tx,orderId);await tx.query('ROLLBACK');}finally{tx.release();}
  pass('actual MOQ and subcontract validation accept20 pieces after the predecessor is closed');
  const token=(await pool.query('SELECT updated_at::text AS token FROM public.commande_fournisseur WHERE id=$1::uuid',[orderId])).rows[0].token;
  await repoUpdateLigne(orderId,lines[1].id,{expected_updated_at:token,patch:{quantite:2}},audit);
  pass('resubmitting the two-piece origin preserves its price snapshot and validates the order total');
  const edited=await pool.connect();try{
    await edited.query('BEGIN');await edited.query('UPDATE public.commande_fournisseur_ligne SET qty_annulee=1 WHERE id=$1::uuid',[lines[1].id]);
    await edited.query('UPDATE public.fournisseur_catalogue SET moq=20 WHERE id=$1::uuid',[offer.id]);
    const small={catalogue_id:offer.id,article_id:purchase.article_id,unite:offer.unit,quantite:2,qty_annulee:1};
    assert.equal(await readCatalogueOrderQuantityTx(edited,orderId,small,lines[1].id),19);
    await assert.rejects(readCatalogueLinePriceTx(edited,orderId,small,{excludeLineId:lines[1].id}),error=>error.code==='CATALOGUE_MINIMUM_QUANTITY');
    await edited.query('ROLLBACK');
  }finally{edited.release();}
  pass('the edited origin also excludes its own cancelled piece from the aggregate');
  for(const setup of [
    ['annulation',`UPDATE public.commande_fournisseur_ligne SET qty_annulee=18 WHERE id=$1::uuid`],
    ['autre article',`UPDATE public.commande_fournisseur_ligne SET article_id=(SELECT article_id FROM public.lots WHERE id=$2::uuid) WHERE id=$1::uuid`]
  ]){
    const client=await pool.connect();try{await client.query('BEGIN');await client.query(setup[1],setup[0]==='annulation'?[lines[0].id]:[lines[0].id,origins[0].id]);
      await assert.rejects(assertCatalogueMinimumsTx(client,orderId),error=>error.code==='CATALOGUE_MINIMUM_QUANTITY');await client.query('ROLLBACK');
    }finally{client.release();}pass('real readiness refuses a total2 left by '+setup[0]);
  }
  // Fixture-only cancellation prepares an independent reversed-order test; no live DB is touched.
  await pool.query("UPDATE public.commande_fournisseur SET statut='ANNULEE' WHERE id=$1::uuid",[orderId]);
  const refreshed=await readSubcontractProcurement(95);
  const reverse=await prepareSubcontractProcurement(95,make(refreshed,[{originId:origins[1].id,quantity:2},{originId:origins[0].id,quantity:18}]),audit);
  assert.equal(reverse.commands.length,1);
  assert.deepEqual((await pool.query('SELECT quantite::float8 AS quantity FROM public.commande_fournisseur_ligne WHERE commande_id=$1::uuid ORDER BY position',[reverse.commands[0].id])).rows.map(l=>l.quantity),[2,18]);
  pass('full preparation also accepts2+18 when the small origin is inserted first');
  await pool.query("UPDATE public.commande_fournisseur SET statut='ANNULEE' WHERE id=$1::uuid",[reverse.commands[0].id]);
  const count=(await pool.query('SELECT count(*)::int AS count FROM public.commande_fournisseur')).rows[0].count;
  await assert.rejects(prepareSubcontractProcurement(95,make(await readSubcontractProcurement(95),[{originId:origins[1].id,quantity:2}]),audit),error=>error.code==='CATALOGUE_MINIMUM_QUANTITY');
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM public.commande_fournisseur')).rows[0].count,count);
  pass('a standalone quantity2 is rejected and its draft is rolled back');
  console.log('CATALOGUE_MINIMUM1265_POSTGRES_PASS: '+passed);
}
main().catch(error=>{console.error({name:error.name,code:error.code,message:error.message,stack:error.stack});process.exitCode=1;}).finally(()=>pool.end());
