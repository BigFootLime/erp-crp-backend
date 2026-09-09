/** Explicitly fictional, retained QA fixtures. Run only against cerp_test.
 * No supplier email/send endpoint is called. SQL marks only new fixture orders sent.
 * Requires CERP_CONSUMABLES_QA_WRITE=1047; credentials remain on the test host. */
export {};
async function main() {
  if(process.env.CERP_CONSUMABLES_QA_WRITE!=='1047'||!process.env.DATABASE_URL) throw new Error('Explicit test-write opt-in required');
  const connection=new URL(process.env.DATABASE_URL); connection.pathname='/cerp_test'; process.env.DATABASE_URL=connection.toString();
  delete process.env.PGOPTIONS;
  const root='/tmp/cerp-1047-qa';
  process.env.CERP_ROOT=root;process.env.CERP_STORAGE_ROOT=root+'/data';
  for(const name of ['DOCUMENTS','GENERATED','INBOUND','EXPORTS','TMP'])process.env[`CERP_${name}_ROOT`]=`${root}/data/${name.toLowerCase()}`;
  const {randomUUID}=require('node:crypto');const fs=require('node:fs/promises');const assert=require('node:assert/strict');
  const pool=require('../../src/config/database').default;
  const {withRealtimeOutboxTransaction:transaction}=require('../../src/shared/realtime/realtime-outbox-transaction');
  const articles=require('../../src/module/stock/repository/stock.repository');
  const supplierRepo=require('../../src/module/fournisseurs/repository/fournisseurs.repository');
  const articleSchema=require('../../src/module/stock/validators/stock.validators').createArticleSchema;
  const supplierSchema=require('../../src/module/fournisseurs/validators/fournisseurs.validators').createFournisseurSchema;
  const {createMaterialDraftsTx}=require('../../src/module/commande-fournisseur/repository/commande-fournisseur.repository');
  const {readExpectedReceiptLinesTx:expected}=require('../../src/module/receptions/repository/expected-receipts.repository');
  const receipts=require('../../src/module/receptions/repository/grouped-receipts.repository');
  const {repoAttachDocuments}=require('../../src/module/receptions/repository/receptions.repository');
  const supply=require('../../src/module/stock/repository/consumable-supply.repository');
  const tag=`QA1047-${Date.now()}`;const evidence:any={tag,database:'cerp_test',checks:[],articles:[],orders:[],receipts:[]};
  let step='preflight';
  async function check(name:string,work:()=>Promise<void>){step=name;await work();evidence.checks.push(name);console.log(JSON.stringify({check:name,result:'PASS'}));}
  async function rejects(work:()=>Promise<unknown>,code:string){await assert.rejects(work,(e:any)=>e.code===code,code);}
  try {
    const db=(await pool.query('SELECT current_database() AS name,current_user AS role')).rows[0];
    assert.equal(db.name,'cerp_test');assert.equal(db.role,'cerp_app');
    const user=(await pool.query("SELECT id FROM public.users WHERE lower(role) LIKE '%administrateur%' ORDER BY id LIMIT 1")).rows[0];
    assert.ok(user,'Test administrator required');
    const audit={user_id:Number(user.id),ip:null,user_agent:'CERP QA1047 synthetic test',device_type:null,os:null,browser:null,path:'/qa/1047',page_key:null,client_session_id:null};
    const destination=(await pool.query('SELECT e.magasin_id::text AS "magasinId",e.id AS "emplacementId" FROM public.emplacements e JOIN public.magasins m ON m.id=e.magasin_id ORDER BY e.id LIMIT 1')).rows[0];
    assert.ok(destination,'Test destination required');
    const supplier=await supplierRepo.repoCreateFournisseur(supplierSchema.parse({body:{nom:`${tag} FOURNISSEUR FICTIF`,status:'a_completer',notes:'RECETTE FICTIVE 1047 — aucun envoi externe, aucune facture réelle.'}}).body,audit,randomUUID());
    evidence.supplierId=supplier.id;
    async function article(label:string,stock:boolean,mode='UNIT',quality=false){
      const body=articleSchema.parse({body:{designation:`${tag} ${label} FICTIF`,article_category:'achat',article_categories:['consommable'],family_code:'CONS',unite:'u',
        stock_managed:stock,lot_tracking:mode==='GLOBAL_PACK',consumption_mode:mode,purchase_pack_qty:100,receipt_quality_required:quality,internal_reference:`${tag}-${label}`,
        notes:'Article de recette automatisée uniquement.',supplier_conditions:[{supplier_id:supplier.id,preferred:true,reference_fournisseur:`${tag}-${label}`,prix_unitaire:2,unite:'u',unite_stock:'u',coef_conversion:1,devise:'EUR',delai_jours:5,lot_achat:100,actif:true}]}}).body;
      const created=await transaction(await pool.connect(),(tx:any)=>articles.repoCreateArticleTx(tx,body,audit));
      evidence.articles.push(created.id);return created.id as string;
    }
    const unitId=await article('UNITE',true),packId=await article('PALETTE',true,'GLOBAL_PACK'),noneId=await article('HORS-STOCK',false),qualityId=await article('QUALITE',true,'UNIT',true);
    async function order(articleId:string,qty:number){
      const current=await supply.getConsumableSupply(articleId),c=current.catalogues[0];assert.ok(c);
      const commands=await transaction(await pool.connect(),(tx:any)=>createMaterialDraftsTx(tx,[{type:'ARTICLE',needId:null,ofId:null,sourceRef:articleId,articleId,designation:current.article.designation,
        supplierId:supplier.id,currency:'EUR',destinationId:destination.magasinId,unit:'u',stockUnit:'u',coefficient:1,catalogueId:c.id,supplierReference:c.reference,
        quantity:qty,assigned:0,price:2,due:null,delay:5,requirements:[],operation:'RECETTE FICTIVE — AUCUN ENVOI'}],audit));
      assert.equal(commands.length,1);const id=commands[0].id;evidence.orders.push(id);
      // Fixture setup only: no send workflow, no external message.
      await pool.query("UPDATE public.commande_fournisseur SET statut='ENVOYEE',note_interne='QA1047 FICTIF — état envoyé simulé uniquement pour la recette, aucun envoi externe.' WHERE id=$1::uuid",[id]);
      return (await pool.query('SELECT id::text FROM public.commande_fournisseur_ligne WHERE commande_id=$1::uuid',[id])).rows[0].id as string;
    }
    const unitLine=await order(unitId,100),packLine=await order(packId,200),noneLine=await order(noneId,100),qualityLine=await order(qualityId,100);
    async function line(id:string){const result=await expected(pool,{page:1,pageSize:100},[id]);assert.equal(result.items.length,1);return result.items[0];}
    async function draft(reference:string,withBl=true){
      const prepared=await receipts.prepareGroupedReceipt({idempotencyKey:randomUUID(),supplierId:supplier.id,reference:`${tag}-${reference}`,date:new Date().toISOString().slice(0,10)},audit);
      evidence.receipts.push(prepared.id);
      if(withBl){
        await fs.mkdir(`${root}/data/tmp`,{recursive:true});const path=`${root}/data/tmp/${randomUUID()}.txt`;
        const content=Buffer.from(`BL FICTIF ${tag} ${reference}\nRecette informatique, aucune livraison réelle.`);await fs.writeFile(path,content,{mode:0o600});
        const docs=await repoAttachDocuments(prepared.id,{document_type:'BON_LIVRAISON',label:'BL FICTIF DE RECETTE'},[{path,originalname:'BL-FICTIF.txt',mimetype:'text/plain',size:content.length}],audit);
        assert.equal(docs.length,1);
      }
      return prepared;
    }
    async function body(id:string,qty:number,packs:any[]=[]){const current=await line(id);return {lineId:id,expectedVersion:current.version,quantity:qty,destination:current.stockManaged?destination:null,supplierLotCode:'LOT-FOURNISSEUR-FICTIF',packs,overReceiptReason:null};}
    async function stock(articleId:string){return Number((await pool.query('SELECT COALESCE(sum(qty_total),0) AS qty FROM public.stock_levels WHERE article_id=$1::uuid',[articleId])).rows[0].qty);}
    await check('missing BL rolls back official receipt',async()=>{
      const d=await draft('SANS-BL',false),b={idempotencyKey:randomUUID(),lines:[await body(unitLine,60)]};
      await rejects(()=>receipts.confirmGroupedReceipt(d.id,b,audit),'RECEIPT_DELIVERY_NOTE_REQUIRED');assert.equal((await line(unitLine)).received,0);assert.equal(await stock(unitId),0);
    });
    await check('receive 60 then replay same response without duplicate stock',async()=>{
      const d=await draft('60'),b={idempotencyKey:randomUUID(),lines:[await body(unitLine,60)]};
      const first=await receipts.confirmGroupedReceipt(d.id,b,audit),replayed=await receipts.confirmGroupedReceipt(d.id,b,audit);
      assert.deepEqual(replayed,first);const l=await line(unitLine);assert.equal(l.received,60);assert.equal(l.remaining,40);assert.equal(await stock(unitId),60);
      await rejects(()=>receipts.confirmGroupedReceipt(d.id,{...b,idempotencyKey:randomUUID()},audit),'RECEIPT_ALREADY_CONFIRMED');
    });
    await check('receive remaining 40 and another order on one BL',async()=>{
      const d=await draft('40-ET-HORS-STOCK');await receipts.confirmGroupedReceipt(d.id,{idempotencyKey:randomUUID(),lines:[await body(unitLine,40),await body(noneLine,100)]},audit);
      assert.equal((await line(unitLine)).remaining,0);assert.equal(await stock(unitId),100);assert.equal((await line(noneLine)).received,100);assert.equal(await stock(noneId),0);
    });
    let lotIds:string[]=[];
    await check('two pallets from the same supplier lot retain distinct identities',async()=>{
      const d=await draft('DEUX-PALETTES');const result=await receipts.confirmGroupedReceipt(d.id,{idempotencyKey:randomUUID(),lines:[await body(packLine,200,[{quantity:100,supplierLotCode:'MEME-LOT'},{quantity:100,supplierLotCode:'MEME-LOT'}])]},audit);
      lotIds=result.lines.map((l:any)=>l.lotId);assert.equal(new Set(lotIds).size,2);assert.equal(await stock(packId),200);
    });
    await check('finish one pallet and replay leaves the other intact',async()=>{
      const current=await supply.getConsumableSupply(packId),p=current.stock.find((p:any)=>p.lotId===lotIds[0]);assert.ok(p);assert.equal(p.available,100);
      const b={idempotencyKey:randomUUID(),expectedVersion:current.version,lotId:p.lotId,scan:p.lotCode,expectedQuantity:100,reason:'QA1047 palette fictive terminée'};
      const result=await supply.depleteConsumablePack(packId,b,audit);assert.deepEqual(await supply.depleteConsumablePack(packId,b,audit),result);assert.equal(await stock(packId),100);
      const after=await supply.getConsumableSupply(packId);assert.equal(after.stock.find((p:any)=>p.lotId===lotIds[1]).total,100);
    });
    await check('anticipated replenishment rounds 120 to 200 without stock exit',async()=>{
      const current=await supply.getConsumableSupply(packId);const result=await supply.replenishConsumable(packId,{idempotencyKey:randomUUID(),expectedVersion:current.version,supplierId:supplier.id,destinationId:destination.magasinId,stockQuantity:120,existingPurchasesReviewed:true,reason:'QA1047 réapprovisionnement anticipé fictif'},audit);
      assert.equal(await stock(packId),100);const id=result.commands[0].id;evidence.orders.push(id);const row=(await pool.query('SELECT quantite FROM public.commande_fournisseur_ligne WHERE commande_id=$1::uuid',[id])).rows[0];assert.equal(Number(row.quantite),200);
    });
    await check('quality-required receipt remains unavailable',async()=>{
      const d=await draft('CONTROLE');const result=await receipts.confirmGroupedReceipt(d.id,{idempotencyKey:randomUUID(),lines:[await body(qualityLine,100)]},audit);
      assert.equal(result.lines[0].state,'QUALITY_PENDING');assert.equal((await line(qualityLine)).received,100);assert.equal((await line(qualityLine)).accepted,0);assert.equal(await stock(qualityId),0);
    });
    const procurement=require('../../src/module/production/repository/consumable-procurement.repository');
    const {getOfConsumables:coverage}=require('../../src/module/production/repository/consumable-procurement-read.repository');
    const {readOfDossierTx}=require('../../src/module/production/repository/of-dossier.repository');
    async function of(label:string,articleId:string,quantities:number[],launched=1){
      // Fixture setup: an explicitly synthetic frozen OF with an operation already
      // completed in its fixture. This exercises procurement, not dossier authoring.
      const product=(await pool.query('SELECT piece_technique_id,piece_technique_version_id FROM public.ordres_fabrication WHERE piece_technique_version_id IS NOT NULL LIMIT 1')).rows[0];assert.ok(product);
      const a=(await pool.query('SELECT designation,unite,stock_managed,consumption_mode,receipt_quality_required FROM public.articles WHERE id=$1::uuid',[articleId])).rows[0];
      const purchases=quantities.map(q=>({id:randomUUID(),type_achat:'CONSOMMABLE',article_id:articleId,quantite:q,unite_prix:a.unite,designation:a.designation,fournisseur_id:supplier.id,
        article_policy:{consumable:true,unit:a.unite,stock_managed:a.stock_managed,consumption_mode:a.consumption_mode,receipt_quality_required:a.receipt_quality_required}}));
      const snapshot={preparation_evidence:{purchases}},hash=require('node:crypto').createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
      const id=await transaction(await pool.connect(),async(tx:any)=>{
        const id=Number((await tx.query(`INSERT INTO public.ordres_fabrication(numero,piece_technique_id,piece_technique_version_id,quantite_lancee,technical_snapshot,technical_snapshot_sha256,technical_snapshot_at,technical_readiness,notes,created_by,updated_by)
          VALUES($1,$2,$3,$7,$4::jsonb,$5,now(),'VALIDATED','QA1047 FICTIF : état initial préparé pour recette approvisionnement uniquement.',$6,$6) RETURNING id`,[`QA1047-${tag.slice(-6)}-${label}`,product.piece_technique_id,product.piece_technique_version_id,JSON.stringify(snapshot),hash,audit.user_id,launched])).rows[0].id);
        await tx.query('INSERT INTO public.of_technical_snapshots(of_id,piece_technique_version_id,snapshot,snapshot_sha256,created_by) VALUES($1,$2,$3::jsonb,$4,$5)',[id,product.piece_technique_version_id,JSON.stringify(snapshot),hash,audit.user_id]);
        const revision=(await tx.query(`INSERT INTO public.of_revisions(of_id,revision_rank,revision_code,statut,snapshot,snapshot_sha256,motif,author_user_id) VALUES($1,1,'R01','ACTIVE',$2::jsonb,$3,'QA1047 FICTIF',$4) RETURNING id`,[id,JSON.stringify(snapshot),hash,audit.user_id])).rows[0].id;
        await tx.query("INSERT INTO public.of_operations(of_id,revision_id,phase,designation,status) VALUES($1,$2,10,'QA1047 opération fictive préexistante','DONE')",[id,revision]);
        const dossier=await readOfDossierTx(tx,id);await tx.query("INSERT INTO public.of_dossier_validations(of_id,source_hash,planning_revision,evidence,decided_by) SELECT $1,$2,revision,'{\"fixture\":\"QA1047\"}'::jsonb,$3 FROM public.planning_central_settings WHERE singleton",[id,dossier.sourceHash,audit.user_id]);await tx.query('SET CONSTRAINTS ALL IMMEDIATE');return id;
      });
      evidence.ofs??=[];evidence.ofs.push(id);
      let current=await coverage(id);assert.equal(current.dossierStatus,'COMPLETE');
      for(const need of current.needs)current=await procurement.configureOfConsumable(id,{idempotencyKey:randomUUID(),expectedVersion:current.version,sourceRef:need.key,supplierId:supplier.id,destinationId:destination.magasinId},audit);
      return id;
    }
    async function prepare(id:number,options:any={}){const current=await coverage(id);return procurement.prepareOfConsumables(id,{idempotencyKey:randomUUID(),expectedVersion:current.version,needs:current.needs.map((n:any)=>({key:n.key,reserve:true,purchase:true,existingPurchasesReviewed:true,future:[],...options}))},audit,{reserve:true,purchase:true});}
    const ofA=await of('OF-A',unitId,[60]),ofB=await of('OF-B',unitId,[60]);
    await check('concurrent OFs cannot reserve the same stock; retry buys only the shortage',async()=>{
      const a=await coverage(ofA),b=await coverage(ofB);
      const attempt=(id:number,c:any)=>procurement.prepareOfConsumables(id,{idempotencyKey:randomUUID(),expectedVersion:c.version,needs:[{key:c.needs[0].key,reserve:true,purchase:true,existingPurchasesReviewed:true,future:[]}]},audit,{reserve:true,purchase:true});
      const results=await Promise.allSettled([attempt(ofA,a),attempt(ofB,b)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
      const rejected=results.find(r=>r.status==='rejected') as PromiseRejectedResult;assert.equal(rejected.reason.code,'CONSUMABLE_COVERAGE_CHANGED');
      const loser=results[0].status==='rejected'?ofA:ofB;const retried=await prepare(loser);assert.equal(retried.coverage.needs[0].reserved,40);assert.equal(retried.coverage.needs[0].expected,20);assert.equal(retried.commands.length,1);
      const sum=(await pool.query('SELECT sum(qty_reserved-qty_consumed) AS qty FROM public.stock_reservations WHERE article_id=$1::uuid AND status=\'ACTIVE\'',[unitId])).rows[0];assert.equal(Number(sum.qty),100);
      const lines=(await pool.query('SELECT quantite FROM public.commande_fournisseur_ligne WHERE commande_id=$1::uuid',[retried.commands[0].id])).rows;assert.equal(Number(lines[0].quantite),100);evidence.orders.push(retried.commands[0].id);
    });
    await check('partial then complete scan consumes one reservation exactly once',async()=>{
      let current=await coverage(ofA);const reservation=current.needs[0].reservations[0];const total=reservation.reserved;
      const body={idempotencyKey:randomUUID(),expectedVersion:current.version,reservationId:reservation.id,reservationVersion:reservation.rowVersion,scan:current.needs[0].articleCode,quantity:10,reason:'QA1047 remise fictive partielle'};
      const first=await procurement.withdrawOfConsumable(ofA,body,audit);assert.deepEqual(await procurement.withdrawOfConsumable(ofA,body,audit),first);assert.equal(await stock(unitId),90);
      const {consumableWithdrawalOwnsMovement}=require('../../src/module/stock/repository/consumable-movement-guard');
      assert.equal(await consumableWithdrawalOwnsMovement(pool,first.stockMovementId),true);
      current=await coverage(ofA);const remaining=current.needs[0].reservations.find((r:any)=>r.id===reservation.id);assert.equal(remaining.consumed,10);
      await procurement.withdrawOfConsumable(ofA,{...body,idempotencyKey:randomUUID(),expectedVersion:current.version,reservationVersion:remaining.rowVersion,quantity:total-10},audit);assert.equal(await stock(unitId),100-total);
      assert.equal(await consumableWithdrawalOwnsMovement(pool,first.stockMovementId),true,'Earlier partial withdrawal remains protected from an independent stock reversal');
    });
    await check('existing unassigned purchase covers a third OF without a new order',async()=>{
      const id=await of('OF-FUTUR',unitId,[30]);const current=await coverage(id),n=current.needs[0],future=n.futureSupplies.find((f:any)=>f.compatible);assert.ok(future);assert.equal(future.available,80);
      const result=await prepare(id,{future:[{lineId:future.id,quantity:30}]});assert.equal(result.commands.length,0);assert.equal(result.coverage.needs[0].expected,30);
    });
    await check('two needs of the same article buy one pack and preserve both identities',async()=>{
      const zero=await article('REGROUPE',true);const id=await of('OF-GROUPE',zero,[40,40]);const result=await prepare(id);assert.equal(result.commands.length,1);
      const rows=(await pool.query('SELECT l.quantite,count(b.id)::int AS allocations,sum(b.quantite_couverte) AS assigned FROM public.commande_fournisseur_ligne l JOIN public.commande_fournisseur_ligne_besoin b ON b.ligne_id=l.id WHERE l.commande_id=$1::uuid GROUP BY l.id',[result.commands[0].id])).rows;
      assert.equal(rows.length,1);assert.equal(Number(rows[0].quantite),100);assert.equal(rows[0].allocations,2);assert.equal(Number(rows[0].assigned),80);evidence.orders.push(result.commands[0].id);
      const commandId=result.commands[0].id;
      await pool.query("UPDATE public.commande_fournisseur SET statut='ENVOYEE',note_interne='QA1047 FICTIF — aucun envoi externe' WHERE id=$1::uuid",[commandId]);
      const lineId=(await pool.query('SELECT id::text FROM public.commande_fournisseur_ligne WHERE commande_id=$1::uuid AND article_id=$2::uuid',[commandId,zero])).rows[0].id;
      const first=await draft('GROUPE-60');await receipts.confirmGroupedReceipt(first.id,{idempotencyKey:randomUUID(),lines:[await body(lineId,60)]},audit);
      const partial=await coverage(id);assert.equal(partial.needs.reduce((sum:number,n:any)=>sum+n.reserved,0),60);
      assert.equal((await line(lineId)).remaining,40);
      const second=await draft('GROUPE-40');await receipts.confirmGroupedReceipt(second.id,{idempotencyKey:randomUUID(),lines:[await body(lineId,40)]},audit);
      const complete=await coverage(id);assert.deepEqual(complete.needs.map((n:any)=>n.reserved),[40,40]);
      const stores=await supply.getConsumableSupply(zero);assert.equal(stores.stock.reduce((sum:number,s:any)=>sum+s.available,0),20);
      assert.equal((await line(lineId)).remaining,0);
    });
    await check('receipt transfers exactly the assigned 50 and leaves surplus available',async()=>{
      const c=(await pool.query(`SELECT DISTINCT c.id,l.id AS line_id FROM public.commande_fournisseur c JOIN public.commande_fournisseur_ligne l ON l.commande_id=c.id
        WHERE l.article_id=$1::uuid AND c.statut='BROUILLON'`,[unitId])).rows[0];assert.ok(c);
      await pool.query("UPDATE public.commande_fournisseur SET statut='ENVOYEE',note_interne='QA1047 FICTIF — aucun envoi externe' WHERE id=$1::uuid",[c.id]);
      const before=await stock(unitId),d=await draft('AFFECTATIONS-OF');const result=await receipts.confirmGroupedReceipt(d.id,{idempotencyKey:randomUUID(),lines:[await body(c.line_id,100)]},audit);
      assert.equal(await stock(unitId),before+100);
      const lots=await supply.getConsumableSupply(unitId),lot=lots.stock.find((s:any)=>s.lotId===result.lines[0].lotId);assert.equal(lot.reserved,50);assert.equal(lot.available,50);
    });
    await check('shared pallet availability creates no per-OF reservation or purchase',async()=>{
      for(const label of ['OF-PARTAGE-A','OF-PARTAGE-B']){const id=await of(label,packId,[1]),result=await prepare(id);assert.equal(result.commands.length,0);assert.equal(result.reservedIds.length,0);assert.equal(result.coverage.needs[0].available,true);}
    });
    await check('non-stock OF purchase receipt covers only assigned need, without stock',async()=>{
      const id=await of('OF-HORS-STOCK',noneId,[60]);const prepared=await prepare(id);assert.equal(prepared.commands.length,1);const command=prepared.commands[0].id;evidence.orders.push(command);
      await pool.query("UPDATE public.commande_fournisseur SET statut='ENVOYEE',note_interne='QA1047 FICTIF — aucun envoi externe' WHERE id=$1::uuid",[command]);
      const lineId=(await pool.query('SELECT id::text FROM public.commande_fournisseur_ligne WHERE commande_id=$1::uuid AND article_id=$2::uuid',[command,noneId])).rows[0].id;
      const d=await draft('OF-HORS-STOCK');const received=await receipts.confirmGroupedReceipt(d.id,{idempotencyKey:randomUUID(),lines:[await body(lineId,100)]},audit);assert.equal(received.lines[0].unallocatedOffStock,40);
      const current=await coverage(id);assert.equal(current.needs[0].receivedAccepted,60);assert.equal(current.needs[0].available,true);assert.equal(await stock(noneId),0);
    });
    async function reviseFrozenFixture(id:number,qty:number){
      // Synthetic revision setup uses the existing revision register. The initial
      // technical snapshot stays immutable, including its original purchase BOM.
      const revisions=require('../../src/module/production/repository/of-versioning.repository');
      await transaction(await pool.connect(),async(tx:any)=>{
        const current=await revisions.getActiveRevision(id,tx),next={...current.snapshot,quantiteLancee:qty};
        const hash=require('node:crypto').createHash('sha256').update(JSON.stringify(next)).digest('hex');
        const created=await revisions.insertRevision(tx,{ofId:id,rank:current.revision_rank+1,code:'R02',snapshot:next,snapshotSha256:hash,diff:{fixture:'QA1047'},motif:'QA1047 révision fictive de quantité',authorUserId:audit.user_id});
        await revisions.copyOperationsToRevision(tx,{ofId:id,fromRevisionId:current.id,toRevisionId:created.id});
        await tx.query('UPDATE public.ordres_fabrication SET quantite_lancee=$2 WHERE id=$1',[id,qty]);
      });
      let c=await coverage(id);assert.equal(c.previousNeeds.length,1);
      c=await procurement.configureOfConsumable(id,{idempotencyKey:randomUUID(),expectedVersion:c.version,sourceRef:c.needs[0].key,supplierId:supplier.id,destinationId:destination.magasinId},audit);
      return c;
    }
    await check('a new frozen OF definition preserves then explicitly carries earlier commitments',async()=>{
      const a=await article('REVISION-REPORT',true),id=await of('REVISION-REPORT',a,[60]);await prepare(id);
      const c=await reviseFrozenFixture(id,2),previous=c.previousNeeds[0];assert.equal(c.needs[0].expected,0);assert.equal(previous.promises[0].assigned,60);
      const b={idempotencyKey:randomUUID(),expectedVersion:c.version,previousNeedId:previous.id,targetKey:c.needs[0].key,disposition:'CARRY',reason:'QA1047 report explicite vers la nouvelle définition figée'};
      const result=await procurement.reconcileOfConsumables(id,b,audit);assert.equal(result.previousNeeds.length,0);assert.equal(result.needs[0].required,120);assert.equal(result.needs[0].expected,60);
      assert.deepEqual(await procurement.reconcileOfConsumables(id,b,audit),result);
    });
    await check('a smaller revision refuses excess commitments and can retain them separately',async()=>{
      const a=await article('REVISION-SURPLUS',true),id=await of('REVISION-SURPLUS',a,[30],2);await prepare(id);
      const c=await reviseFrozenFixture(id,1),previous=c.previousNeeds[0];
      const b={idempotencyKey:randomUUID(),expectedVersion:c.version,previousNeedId:previous.id,targetKey:c.needs[0].key,disposition:'CARRY',reason:'QA1047 contrôle du surplus à rapprocher explicitement'};
      await rejects(()=>procurement.reconcileOfConsumables(id,b,audit),'CONSUMABLE_REVISION_SURPLUS');
      const result=await procurement.reconcileOfConsumables(id,{...b,idempotencyKey:randomUUID(),targetKey:null,disposition:'KEEP_SEPARATE'},audit);
      assert.equal(result.previousNeeds.length,0);assert.equal(result.needs[0].expected,0);
      assert.equal(Number((await pool.query('SELECT quantite_couverte FROM public.commande_fournisseur_ligne_besoin WHERE id=$1::uuid',[previous.promises[0].id])).rows[0].quantite_couverte),60);
    });
    evidence.result='PASS';await fs.mkdir(root,{recursive:true});await fs.writeFile(`${root}/${tag}.json`,JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
  } catch(e:any){process.stderr.write(JSON.stringify({result:'FAIL',step,code:e.code??'ERROR',message:String(e.message).replace(/postgres(?:ql)?:\/\/[^\s]+/g,'[redacted]'),evidence}));process.exitCode=1;}
  finally{await pool.end();}
}
main().catch((e:any)=>{process.stderr.write(JSON.stringify({result:'FAIL',message:String(e.message).replace(/postgres(?:ql)?:\/\/[^\s]+/g,'[redacted]')}));process.exitCode=1;});
