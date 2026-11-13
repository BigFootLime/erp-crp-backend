/* Synthetic two-company qualification. All IDs, identities and prices are TEST-only. */
import { Pool } from "pg";
import crypto from "node:crypto";
import { createServer } from "node:http";
import globalPool from "../../src/config/database";
import { repoCreateCommandeNativeTx } from "../../src/module/commande-client/repository/commande-client.repository";
import { receiveIntercompanyMessage } from "../../src/module/entreprises/intercompany/intercompany-inbox.repository";
import { applyPurchaseSubmittedTx, decideIntercompanyRequest } from "../../src/module/entreprises/intercompany/intercompany-requests.repository";
import { applyCommercialIntercompanyMessageTx } from "../../src/module/entreprises/intercompany/commercial-intercompany-message.repository";
import { repoRunCommandeWorkflowAction, repoGenerateAffairesFromOrder } from "../../src/module/commande-client/repository/commande-client.repository";
import { repoCreateLivraisonFromCommande, repoGetLivraisonDetail } from "../../src/module/livraisons/repository/livraisons.repository";
import { repoVerifyPreparationLot } from "../../src/module/livraisons/repository/livraisons.repository";
import { svcGenerateCommandeAr, svcSendCommandeAr } from "../../src/module/commande-client/services/commande-ar.service";
import { repoGetLivraisonShipmentPreview, repoShipLivraison } from "../../src/module/livraisons/repository/livraisons-shipment.repository";
import { repoFreezeDeliveryQualityDossier } from "../../src/module/livraisons/repository/quality-dossier.repository";
import { svcGenerateLivraisonPack } from "../../src/module/livraisons/services/pack.service";
import { repoGetLivraisonPackPreview } from "../../src/module/livraisons/repository/pack.repository";
import { repoConfirmLivraisonPreparation, repoGetLivraisonPreparation } from "../../src/module/livraisons/repository/livraisons-preparation.repository";
import { runAuthoritativePdfArchiveWorkerOnce } from "../../src/shared/authoritative-documents/authoritative-document.worker";
import { repoFindCommandeArOfficialArchiveId } from "../../src/module/commande-client/repository/commande-ar.repository";
import { applyIntercompanyFulfilmentMessageTx } from "../../src/module/entreprises/intercompany/intercompany-fulfilment.repository";
import type { IntercompanyMessage } from "../../src/module/entreprises/intercompany/intercompany-message";

const buyerUrl = process.env.CERP_E2E_BUYER_DATABASE_URL;
const sellerUrl = process.env.CERP_E2E_SELLER_DATABASE_URL;
if (!buyerUrl || !sellerUrl) throw new Error("CERP_E2E_BUYER_DATABASE_URL and CERP_E2E_SELLER_DATABASE_URL are required");
for (const [label, value, database] of [["buyer", buyerUrl, "cerp_ec1454_buyer_v2"], ["seller", sellerUrl, "cerp_ec1454_seller_v2"]] as const) {
  const parsed = new URL(value);
  if (!['127.0.0.1','localhost','::1'].includes(parsed.hostname) || parsed.port !== '15464' || parsed.pathname !== `/${database}`) throw new Error(`Unsafe ${label} fixture URL`);
}
const buyerCompany = "11111111-1111-4111-8111-111111111111";
const sellerCompany = "22222222-2222-4222-8222-222222222222";
const relation = "33333333-3333-4333-8333-333333333333";
const mapping = "44444444-4444-4444-8444-444444444444";
const catalogue = "55555555-5555-4555-8555-555555555555";
const article = "22000000-0000-4000-8000-000000000001";
const supplier = "50000000-0000-4000-8000-000000000001";
const stockLocation = "10000000-0000-4000-8000-000000000145";
const stockWarehouse = "15000000-0000-4000-8000-000000000145";
const stockMagasin = "25000000-0000-4000-8000-000000000145";
const stockLevel = "30000000-0000-4000-8000-000000000145";
const stockBatch = "40000000-0000-4000-8000-000000000145";
const stockLot = "41000000-0000-4000-8000-000000000145";
const buyerBiller = "b7000000-0000-4000-8000-000000000145";
const buyerLegalName = "TEST EC ACHETEUR v2";

async function startFixtureEmailSink(): Promise<{ close: () => Promise<void>; baseUrl: string }> {
  const server = createServer((request, response) => {
    request.resume();
    request.once("end", () => {
      if (request.method !== "POST" || request.url !== "/emails") {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "fixture-ar-send" }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("TEST email sink address unavailable");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

async function seedBuyer(pool: Pool) {
  // A separate synthetic buyer identity is essential: the supplier's BL must
  // display the buyer's frozen legal identity, never the seller's baseline one.
  await pool.query(`INSERT INTO factureur(biller_id,biller_name,street,house_number,postal_code,city,country,email)
    VALUES($1,$2,'Avenue Fixture','1','69001','Lyon','France','buyer-fixture@example.local')
    ON CONFLICT(biller_id) DO UPDATE SET biller_name=EXCLUDED.biller_name,street=EXCLUDED.street,house_number=EXCLUDED.house_number,postal_code=EXCLUDED.postal_code,city=EXCLUDED.city,country=EXCLUDED.country,email=EXCLUDED.email`,[buyerBiller,buyerLegalName]);
  await pool.query(`INSERT INTO finance_legal_mentions(biller_id,version,effective_from,legal_form,recovery_indemnity,share_capital_currency,extra_mentions)
    SELECT $1,1,'2026-01-01','TEST',0,'EUR',ARRAY['TEST-only EC buyer identity']
    WHERE NOT EXISTS (SELECT 1 FROM finance_legal_mentions WHERE biller_id=$1 AND version=1)
    -- Do not overwrite the fixture's complete EC fiscal setup.  The final
    -- billing qualification uses the same issuer/policy/sequence state that
    -- has already been configured in buyer_v2.
    `,[buyerBiller]);
  await pool.query("INSERT INTO erp_settings(key,value_text) VALUES('company.primary_biller_id',$1) ON CONFLICT(key) DO UPDATE SET value_text=EXCLUDED.value_text",[buyerBiller]);
  // This is the normal EC customer-record destination used by the commercial
  // form when no intercompany override is supplied. It is deliberately
  // distinct from the CRP-side EC master address.
  await pool.query(`UPDATE public.adresse_livraison address
    SET name='TEST final customer', street='1 rue Fixture TEST', house_number=NULL,
        address_complement=NULL, postal_code='69001', city='Lyon', country='France'
    FROM public.clients customer
    WHERE customer.client_id='901' AND customer.delivery_address_id=address.delivery_address_id`);
  // The EC invoice customer is the actual final consumer.  Keep it separate
  // from the seller-side relation customer seeded below: that customer remains
  // the professional EC company for the supplier's invoice.
  await pool.query(`UPDATE public.clients
    SET company_name='TEST final customer', customer_type='INDIVIDUAL',
        individual_first_name='TEST', individual_last_name='final customer',
        siren=NULL, siret=NULL, vat_number=NULL, naf_code=NULL
    WHERE client_id='901'`);
  await pool.query(`INSERT INTO intercompany_supplier_relations(id,buyer_company_id,supplier_company_id,local_role,environment,local_supplier_id,approval_profile_ids,status,currency)
    VALUES($1,$2,$3,'BUYER','cerp_test',$4,ARRAY['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']::uuid[],'ACTIVE','EUR') ON CONFLICT(id) DO NOTHING`,[relation,buyerCompany,sellerCompany,supplier]);
  await pool.query(`INSERT INTO fournisseur_catalogue(id,fournisseur_id,type,article_id,designation,reference_fournisseur,unite,prix_unitaire,devise,actif)
    VALUES($1,$2,'AUTRE',$3,'TEST fournisseur CRP','TEST-CRP-001','u',70,'EUR',true) ON CONFLICT(id) DO UPDATE SET article_id=EXCLUDED.article_id`,[catalogue,supplier,article]);
  await pool.query(`INSERT INTO intercompany_commercial_catalogue(id,relation_id,local_role,local_article_id,supplier_catalogue_id,supplier_catalogue_mapping_id,supplier_mapping_version,supplier_article_id,supplier_reference,designation,unit,buyer_sale_unit_price,buyer_sale_vat_rate,purchase_unit_price,purchase_vat_rate,currency,active)
    VALUES($1,$2,'BUYER',$3,$4,$5,1,$3,'TEST-CRP-001','TEST article dropship','u',120,20,70,20,'EUR',true) ON CONFLICT(id) DO UPDATE SET local_article_id=EXCLUDED.local_article_id,supplier_article_id=EXCLUDED.supplier_article_id`,[mapping,relation,article,catalogue,mapping]);
}
async function seedSeller(pool: Pool) {
  // The supplier-side relation customer is the EC business, never the final
  // consumer. Keep its master delivery address untouched: the BL destination
  // is instead supplied by the immutable intercompany snapshot.
  await pool.query(`UPDATE public.clients
    SET company_name='TEST EC ACHETEUR v2', customer_type='PROFESSIONAL',
        individual_first_name=NULL, individual_last_name=NULL,
        siren='123456789', siret='12345678900010', vat_number='FR123456789', naf_code='2562B'
    WHERE client_id='901'`);
  await pool.query("UPDATE users SET directory_profile_id='77777777-7777-4777-8777-777777777777'::uuid WHERE username='KEENAN' AND directory_profile_id IS NULL");
  await pool.query("INSERT INTO app_module_user_access(user_id,module_key,access) VALUES(1,'commandes-clients','GRANTED') ON CONFLICT(user_id,module_key) DO UPDATE SET access='GRANTED'");
  const approver=await pool.query<{directory_profile_id:string}>("SELECT directory_profile_id::text FROM users WHERE username='KEENAN' LIMIT 1");
  const profile=approver.rows[0]?.directory_profile_id; if(!profile) throw new Error("TEST approver unavailable");
  await pool.query(`INSERT INTO intercompany_supplier_relations(id,buyer_company_id,supplier_company_id,local_role,environment,local_customer_id,approval_profile_ids,status,currency)
    VALUES($1,$2,$3,'SUPPLIER','cerp_test','901',ARRAY[$4]::uuid[],'ACTIVE','EUR') ON CONFLICT(id) DO NOTHING`,[relation,buyerCompany,sellerCompany,profile]);
  await pool.query(`INSERT INTO intercompany_commercial_catalogue(id,relation_id,local_role,local_article_id,supplier_catalogue_mapping_id,supplier_mapping_version,supplier_article_id,supplier_reference,designation,unit,supplier_sale_unit_price,purchase_vat_rate,currency,active)
    VALUES($1,$2,'SUPPLIER',$3,$1,1,$3,'TEST-CRP-001','TEST article dropship','u',70,20,'EUR',true) ON CONFLICT(id) DO NOTHING`,[mapping,relation,article]);
  const offer={supplier_article_id:article,supplier_piece_technique_id:null,supplier_piece_technique_version_id:null,unit:'u',supplier_sale_unit_price:70,purchase_vat_rate:20,currency:'EUR',designation:'TEST article dropship'};
  await pool.query(`INSERT INTO intercompany_supplier_offer_revisions(relation_id,supplier_catalogue_mapping_id,version,snapshot,snapshot_sha256) VALUES($1,$2,1,$3::jsonb,$4) ON CONFLICT(relation_id,supplier_catalogue_mapping_id,version) DO NOTHING`,[relation,mapping,JSON.stringify(offer),crypto.createHash('sha256').update(JSON.stringify(offer)).digest('hex')]);
}
async function seedSellerShipmentStock(pool: Pool, technicalVersionId: string) {
  // Explicitly TEST-only OLD provenance: it has a real persisted lot, balance and
  // historical document reference, so the native OLD -> NEW policy may reserve it.
  await pool.query(`INSERT INTO warehouses(id,code,name) VALUES($1,'E2E-EC-OLD','TEST EC historical stock') ON CONFLICT(id) DO UPDATE SET code=EXCLUDED.code,name=EXCLUDED.name`, [stockWarehouse]);
  await pool.query(`INSERT INTO locations(id,warehouse_id,code,description) VALUES($1,$2,'E2E-EC-OLD','TEST EC historical location') ON CONFLICT(id) DO UPDATE SET warehouse_id=EXCLUDED.warehouse_id`, [stockLocation,stockWarehouse]);
  await pool.query(`INSERT INTO magasins(id,code,name,is_active,code_magasin,libelle,actif,warehouse_id,stock_scope) VALUES($1,'E2E-EC-OLD','TEST EC historical store',true,'E2E-EC-OLD','TEST EC historical store',true,$2,'OLD') ON CONFLICT(id) DO UPDATE SET warehouse_id=EXCLUDED.warehouse_id,stock_scope='OLD',actif=true,is_active=true`,[stockMagasin,stockWarehouse]);
  await pool.query(`INSERT INTO emplacements(id,magasin_id,code,name,is_active,location_id,location_type,allow_inbound,allow_outbound) VALUES(900145,$1,'E2E-EC-OLD','TEST EC historical bin',true,$2,'STORAGE',true,true) ON CONFLICT(id) DO UPDATE SET magasin_id=EXCLUDED.magasin_id,location_id=EXCLUDED.location_id,is_active=true,allow_outbound=true`,[stockMagasin,stockLocation]);
  // The seller order fixes its article/version when it is accepted.  The test
  // lot deliberately uses that same real fixture lineage, not an invented
  // article or compatibility bypass.
  await pool.query(`INSERT INTO lots(id,article_id,lot_code,lot_status,piece_technique_version_id,source_scope,stock_scope,origin_stock_scope) VALUES($1,$2,'TEST-EC-OLD-145','LIBERE',$3::uuid,'OLD','OLD','OLD') ON CONFLICT(id) DO UPDATE SET article_id=EXCLUDED.article_id,lot_status='LIBERE',piece_technique_version_id=EXCLUDED.piece_technique_version_id,source_scope='OLD',stock_scope='OLD',origin_stock_scope='OLD'`,[stockLot,article,technicalVersionId]);
  await pool.query(`INSERT INTO stock_levels(id,article_id,unit_id,warehouse_id,location_id,managed_in_stock,qty_total,qty_reserved,qty_depreciated) SELECT $1,$2,u.id,$3,$4,true,2,0,0 FROM units u WHERE u.code='u' ON CONFLICT(id) DO UPDATE SET qty_total=2,qty_reserved=0,qty_depreciated=0`,[stockLevel,article,stockWarehouse,stockLocation]);
  await pool.query(`INSERT INTO stock_batches(id,stock_level_id,batch_code,qty_total,qty_reserved,qty_depreciated,lot_id) VALUES($1,$2,'TEST-EC-OLD-145',2,0,0,$3) ON CONFLICT(id) DO UPDATE SET qty_total=2,qty_reserved=0,qty_depreciated=0,lot_id=EXCLUDED.lot_id`,[stockBatch,stockLevel,stockLot]);
  await pool.query(`INSERT INTO old_stock_document_references(lot_id,type,label,location,reason,created_by,idempotency_key,request_hash) VALUES($1,'CERTIFICAT_MP','TEST EC historical certificate','fixture://intercompany-1454','TEST-only historical quality provenance',1,'42000000-0000-4000-8000-000000000145',$2) ON CONFLICT DO NOTHING`,[stockLot,'a'.repeat(64)]);
}

async function main() {
  const buyer=new Pool({connectionString:buyerUrl}); const seller=new Pool({connectionString:sellerUrl});
  try {
    const identities=await Promise.all([buyer.query<{database:string}>('SELECT current_database() AS database'),seller.query<{database:string}>('SELECT current_database() AS database')]);
    if(identities[0].rows[0]?.database!=='cerp_ec1454_buyer_v2'||identities[1].rows[0]?.database!=='cerp_ec1454_seller_v2') throw new Error('fixture database identity mismatch');
    const initialBuyerStockMovements=await buyer.query<{count:string}>('SELECT count(*)::text AS count FROM stock_movements');
    await seedBuyer(buyer); await seedSeller(seller);
    process.env.CERP_BUSINESS_COMPANIES_ENABLED='true'; process.env.CERP_SHARED_DIRECTORY_ENABLED='true'; process.env.CERP_COMPANY_ID=buyerCompany; process.env.CERP_COMPANY_ENVIRONMENT='cerp_test';
    const client=await buyer.connect(); let created:{id:number;numero:string};
    try { await client.query('BEGIN'); created=await repoCreateCommandeNativeTx(client,{client_id:'901',code_client:'E2E-CLIENT-901',date_commande:'2026-10-27',order_type:'FERME',fulfilment_mode:'SUPPLIER_DROPSHIP',total_ht:240,total_ttc:288,lignes:[{article_id:article,intercompany_catalogue_mapping_id:mapping,designation:'TEST article dropship',quantite:2,unite:'u',prix_unitaire_ht:120,taux_tva:20}]},1); await client.query('COMMIT'); } catch(e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    const queued=await buyer.query<{message:IntercompanyMessage}>("SELECT message FROM cerp_intercompany_outbox WHERE kind='PURCHASE_SUBMITTED' ORDER BY created_at DESC LIMIT 1"); const message=queued.rows[0]?.message; if(!message) throw new Error('PURCHASE_SUBMITTED outbox message absent');
    // Decision-side helpers resolve the local company from the runtime env.
    // The SQL work below remains on the explicit seller pool.
    process.env.CERP_COMPANY_ID=sellerCompany;
    const receipt=await receiveIntercompanyMessage(seller,message,{PURCHASE_SUBMITTED:applyPurchaseSubmittedTx});
    const pending=await seller.query<{id:string;version:number}>("SELECT id::text,version FROM cerp_intercompany_requests WHERE buyer_purchase_order_id=$1",[message.aggregate_id]); const request=pending.rows[0]; if(!request) throw new Error('seller request absent');
    const result=await decideIntercompanyRequest(seller,{company_id:sellerCompany,environment:'cerp_test',profile:'INDUSTRIAL',module_keys:['commandes-clients']} as never,1,request.id,{action:'ACCEPT',expected_version:Number(request.version),idempotency_key:'66666666-6666-4666-8666-666666666666'});
    const sellerOrderId = String(result.supplier_sales_order_id);
    const sellerOrderVersion=(await seller.query<{version:string}>("SELECT piece_technique_version_id::text AS version FROM commande_ligne WHERE commande_id=$1 AND article_id=$2::uuid LIMIT 1",[sellerOrderId,article])).rows[0]?.version;
    if(!sellerOrderVersion) throw new Error('TEST seller order technical version absent');
    await seedSellerShipmentStock(seller,sellerOrderVersion);
    // The process was launched seller-scoped before imports: these are the real
    // command, reservation, BL preparation and shipment repositories.
    await repoRunCommandeWorkflowAction(sellerOrderId,{action:'check_stock'} as never,1,'Administrateur Systeme et Reseau');
    await repoGenerateAffairesFromOrder(sellerOrderId,{decision:null,livraison_count:1,lines:[]} as never,{user_id:1,user_role:'Administrateur Systeme et Reseau',ip:null,user_agent:null,device_type:null,os:null,browser:null,path:null,page_key:'e2e.intercompany',client_session_id:null});
    const delivery=await repoCreateLivraisonFromCommande(Number(sellerOrderId),1);
    const assertNativeDestination = (detail: Awaited<ReturnType<typeof repoGetLivraisonDetail>> | null, stage: string) => {
      const address = detail?.bon_livraison.adresse_livraison;
      if (!address || address.name !== 'TEST final customer' || address.street !== '1 rue Fixture TEST' || address.postal_code !== '69001' || address.city !== 'Lyon') {
        throw new Error(`TEST ${stage} native BL destination is not the frozen final customer`);
      }
      return address.label;
    };
    const nativeDestinationBeforeShipment = assertNativeDestination(await repoGetLivraisonDetail(delivery.id), 'before shipment');
    const sellerMasterAddress = await seller.query<{name:string;street:string;postal_code:string;city:string}>(`SELECT address.name,address.street,address.postal_code,address.city FROM clients customer JOIN adresse_livraison address ON address.delivery_address_id=customer.delivery_address_id WHERE customer.client_id='901'`);
    if (sellerMasterAddress.rows[0]?.street === '1 rue Fixture TEST') throw new Error('TEST supplier EC master address was overwritten by final customer destination');
    const ar=await svcGenerateCommandeAr({commande_id:Number(sellerOrderId),user_id:1,user_role:'Administrateur Systeme et Reseau',idempotency_key:delivery.id});
    // The normal worker owns the authoritative GED transition.  Drain its
    // bounded durable queue here instead of fabricating an archived document.
    let arArchiveId: string | null = null;
    for(let attempt=0;attempt<20&&!arArchiveId;attempt+=1) {
      await runAuthoritativePdfArchiveWorkerOnce(undefined,`fixture-pdf-worker:${process.pid}`);
      arArchiveId=await repoFindCommandeArOfficialArchiveId(Number(sellerOrderId),ar.ar_id);
    }
    if(!arArchiveId) throw new Error('TEST seller AR official archive was not produced by the native worker');
    const emailSink=await startFixtureEmailSink();
    try {
      process.env.CERP_E2E_EMAIL_SINK='1';
      process.env.RESEND_API_KEY='fixture-local-only';
      process.env.RESEND_FROM='sender@example.local';
      process.env.RESEND_API_BASE_URL=emailSink.baseUrl;
      await svcSendCommandeAr({commande_id:Number(sellerOrderId),user_id:1,user_role:'Administrateur Systeme et Reseau',body:{ar_id:ar.ar_id,recipient_emails:['fixture@example.local'],recipient_contact_ids:[],idempotency_key:delivery.id,email_body:null,message:null} as never});
    } finally { await emailSink.close(); }
    const reservation=(await seller.query<{id:string}>(`SELECT reservation.id::text AS id FROM stock_reservations reservation JOIN bon_livraison_ligne line ON line.id=reservation.bon_livraison_ligne_id WHERE line.bon_livraison_id=$1::uuid AND reservation.status='ACTIVE' LIMIT 1`,[delivery.id])).rows[0]?.id;
    if(!reservation) throw new Error('TEST seller reservation absent');
    await repoVerifyPreparationLot({reservation_id:reservation,qty:2,scanned_lot_code:'TEST-EC-OLD-145'} as never,1);
    const preparation=await repoGetLivraisonPreparation(delivery.id);
    const preparationTask=preparation?.tasks.find(task=>task.reservation_status==='ACTIVE'&&task.lot_code==='TEST-EC-OLD-145');
    if(!preparation||!preparationTask?.can_confirm) throw new Error('TEST seller physical preparation task unavailable');
    await repoConfirmLivraisonPreparation(delivery.id,preparationTask.allocation_id,{expected_version:preparation.row_version,input_method:'SCANNER',scan_code:'TEST-EC-OLD-145'} as never,1,`${delivery.id}:pick`);
    const shipmentPreview=await repoGetLivraisonShipmentPreview(delivery.id);
    if(!shipmentPreview?.quality_release || shipmentPreview.quality_release.state!=='READY') throw new Error(`TEST seller quality release is not ready: ${shipmentPreview?.quality_release?.state ?? 'missing'}`);
    await repoFreezeDeliveryQualityDossier({bonLivraisonId:delivery.id,expectedPreviewSha256:shipmentPreview.quality_release.preview_sha256,reason:'TEST historical OLD quality dossier',actorUserId:1,idempotencyKey:delivery.id});
    await svcGenerateLivraisonPack({bonLivraisonId:delivery.id,actorUserId:1,body:{quality_preview_sha256:shipmentPreview.quality_release.preview_sha256,include_documents:false} as never});
    const packPreview = await repoGetLivraisonPackPreview(delivery.id);
    const packAddress = packPreview.bon_livraison.adresse_livraison;
    if (!packAddress || packAddress.name !== 'TEST final customer' || packAddress.street !== '1 rue Fixture TEST' || packAddress.postal_code !== '69001' || packAddress.city !== 'Lyon') throw new Error('TEST pack reader does not expose the frozen final destination');
    const readyPreview=await repoGetLivraisonShipmentPreview(delivery.id);
    if(!readyPreview?.can_ship) throw new Error(`TEST seller BL remains blocked after native preparation and pack: ${JSON.stringify(readyPreview?.blockers ?? [])}`);
    await repoShipLivraison(delivery.id,{expected_version:readyPreview.row_version,preview_hash:readyPreview.preview_hash,commentaire:'TEST EC shipment'} as never,1,delivery.id);
    const nativeDestinationAfterShipment = assertNativeDestination(await repoGetLivraisonDetail(delivery.id), 'after shipment');
    const dispatched=(await seller.query<{message:IntercompanyMessage}>("SELECT message FROM cerp_intercompany_outbox WHERE kind='SHIPMENT_DISPATCHED' ORDER BY created_at DESC LIMIT 1")).rows[0]?.message;
    if(!dispatched) throw new Error('SHIPMENT_DISPATCHED outbox message absent');
    const snapshot=dispatched.payload as { document:{id:string;snapshot_sha256?:string}; lines:Array<{quantity:number}> };
    if(snapshot.lines.reduce((sum,line)=>sum+Number(line.quantity),0)!==2) throw new Error('shipment snapshot is not complete');
    const legalSnapshot=await seller.query<{snapshot:{issuer?:{company_name?:string};client_name?:string;address_label?:string}}>("SELECT source_snapshot AS snapshot FROM authoritative_pdf_archives WHERE id=$1::uuid AND document_kind='DELIVERY_NOTE_SHIPPED'",[snapshot.document.id]);
    const documentSnapshot=legalSnapshot.rows[0]?.snapshot;
    if(documentSnapshot?.issuer?.company_name!==buyerLegalName||documentSnapshot.client_name!=='TEST final customer'||!documentSnapshot.address_label?.includes('1 rue Fixture TEST')) throw new Error('seller shipment snapshot does not retain TEST buyer identity and final destination');
    const decision=(await seller.query<{message:IntercompanyMessage}>("SELECT message FROM cerp_intercompany_outbox WHERE kind='ORDER_DECIDED' ORDER BY created_at DESC LIMIT 1")).rows[0]?.message; if(!decision) throw new Error('ORDER_DECIDED outbox message absent');
    process.env.CERP_COMPANY_ID=buyerCompany;
    const acknowledgement=await receiveIntercompanyMessage(buyer,decision,{ORDER_DECIDED:applyCommercialIntercompanyMessageTx});
    const replay=await receiveIntercompanyMessage(buyer,decision,{ORDER_DECIDED:applyCommercialIntercompanyMessageTx});
    const fulfilment=await receiveIntercompanyMessage(buyer,dispatched,{SHIPMENT_DISPATCHED:applyIntercompanyFulfilmentMessageTx});
    const fulfilmentReplay=await receiveIntercompanyMessage(buyer,dispatched,{SHIPMENT_DISPATCHED:applyIntercompanyFulfilmentMessageTx});
    const receiptCount=await buyer.query<{count:string}>("SELECT count(*)::text AS count FROM cerp_intercompany_external_fulfilment_receipts WHERE message_id=$1",[dispatched.id]);
    const buyerStatus=await buyer.query<{statut:string}>("SELECT nouveau_statut AS statut FROM commande_historique WHERE commande_id=$1 ORDER BY date_action DESC,id DESC LIMIT 1",[created!.id]);
    const finalBuyerStockMovements=await buyer.query<{count:string}>('SELECT count(*)::text AS count FROM stock_movements');
    if(receiptCount.rows[0]?.count!=='1'||buyerStatus.rows[0]?.statut!=='LIVRE'||finalBuyerStockMovements.rows[0]?.count!==initialBuyerStockMovements.rows[0]?.count) throw new Error('buyer receipt did not complete dropship delivery exactly once without local stock movement');
    const linked=await buyer.query<{supplier_order_state:string;supplier_sales_order_id:string}>("SELECT supplier_order_state,supplier_sales_order_id FROM intercompany_purchase_order_links WHERE buyer_sales_order_id=$1",[created!.id]); if(linked.rows[0]?.supplier_order_state!=='ACCEPTED') throw new Error('buyer decision projection absent');
    const finalSeller=await seller.query<{status:string;posted:string}>(`SELECT bl.statut AS status,COUNT(m.id)::text AS posted FROM bon_livraison bl LEFT JOIN stock_movements m ON m.source_document_id=bl.id::text AND m.status='POSTED' WHERE bl.id=$1::uuid GROUP BY bl.statut`,[delivery.id]);
    if(finalSeller.rows[0]?.status!=='SHIPPED'||finalSeller.rows[0]?.posted!=='1') throw new Error('seller shipment durable assertions failed');
    const [buyerLines,sellerLines,deliveryLines]=await Promise.all([
      buyer.query<{id:string}>("SELECT id::text FROM commande_ligne WHERE commande_id=$1 ORDER BY id",[created!.id]),
      seller.query<{id:string}>("SELECT id::text FROM commande_ligne WHERE commande_id=$1 ORDER BY id",[sellerOrderId]),
      seller.query<{id:string}>("SELECT id::text FROM bon_livraison_ligne WHERE bon_livraison_id=$1::uuid ORDER BY id",[delivery.id]),
    ]);
    process.stdout.write(`E2E_DURABLE_PASS ${JSON.stringify({buyer_database:identities[0].rows[0].database,seller_database:identities[1].rows[0].database,buyer_legal_name:documentSnapshot.issuer?.company_name,buyer_order:created!.id,buyer_lines:buyerLines.rows.map(row=>row.id),seller_order:sellerOrderId,seller_lines:sellerLines.rows.map(row=>row.id),seller_delivery:delivery.id,seller_delivery_lines:deliveryLines.rows.map(row=>row.id),shipment_message:dispatched.id,shipment_document:snapshot.document.id,shipment_document_snapshot_sha256:snapshot.document.snapshot_sha256 ?? null,shipment_recipient:documentSnapshot.client_name,shipment_destination:documentSnapshot.address_label,native_destination_before_shipment:nativeDestinationBeforeShipment,native_destination_after_shipment:nativeDestinationAfterShipment,pack_destination:packAddress.label,seller_ec_master_address:sellerMasterAddress.rows[0] ?? null,ar_official_archive:arArchiveId,buyer_status:buyerStatus.rows[0]?.statut,receipt_count:receiptCount.rows[0]?.count,buyer_stock_movements_before:initialBuyerStockMovements.rows[0]?.count,buyer_stock_movements_after:finalBuyerStockMovements.rows[0]?.count,stock_movements_posted:finalSeller.rows[0]?.posted})}\n`);
  } finally { await buyer.end(); await seller.end(); await globalPool.end(); }
}
main().catch(error=>{process.stderr.write(`E2E_DURABLE_FAIL ${error instanceof Error?error.stack:String(error)}\n`);process.exitCode=1});
