/* Synthetic two-company qualification. All IDs, identities and prices are TEST-only. */
import { Pool } from "pg";
import crypto from "node:crypto";
import { repoCreateCommandeNativeTx } from "../../src/module/commande-client/repository/commande-client.repository";
import { receiveIntercompanyMessage } from "../../src/module/entreprises/intercompany/intercompany-inbox.repository";
import { applyPurchaseSubmittedTx, decideIntercompanyRequest } from "../../src/module/entreprises/intercompany/intercompany-requests.repository";
import { applyCommercialIntercompanyMessageTx } from "../../src/module/entreprises/intercompany/commercial-intercompany-message.repository";
import { repoRunCommandeWorkflowAction, repoGenerateAffairesFromOrder } from "../../src/module/commande-client/repository/commande-client.repository";
import { repoCreateLivraisonFromCommande } from "../../src/module/livraisons/repository/livraisons.repository";
import { repoVerifyPreparationLot } from "../../src/module/livraisons/repository/livraisons.repository";
import { svcGenerateCommandeAr, svcSendCommandeAr } from "../../src/module/commande-client/services/commande-ar.service";
import { repoGetLivraisonShipmentPreview, repoShipLivraison } from "../../src/module/livraisons/repository/livraisons-shipment.repository";
import { repoFreezeDeliveryQualityDossier } from "../../src/module/livraisons/repository/quality-dossier.repository";
import { svcGenerateLivraisonPack } from "../../src/module/livraisons/services/pack.service";
import { applyIntercompanyFulfilmentMessageTx } from "../../src/module/entreprises/intercompany/intercompany-fulfilment.repository";
import type { IntercompanyMessage } from "../../src/module/entreprises/intercompany/intercompany-message";

const buyerUrl = process.env.CERP_E2E_BUYER_DATABASE_URL;
const sellerUrl = process.env.CERP_E2E_SELLER_DATABASE_URL;
if (!buyerUrl || !sellerUrl) throw new Error("CERP_E2E_BUYER_DATABASE_URL and CERP_E2E_SELLER_DATABASE_URL are required");
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

async function seedBuyer(pool: Pool) {
  await pool.query("INSERT INTO erp_settings(key,value_text) VALUES('company.primary_biller_id','b7c1e5a2-3f4d-4e8b-9a06-380569012000') ON CONFLICT(key) DO UPDATE SET value_text=EXCLUDED.value_text");
  await pool.query(`INSERT INTO intercompany_supplier_relations(id,buyer_company_id,supplier_company_id,local_role,environment,local_supplier_id,approval_profile_ids,status,currency)
    VALUES($1,$2,$3,'BUYER','cerp_test',$4,ARRAY['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']::uuid[],'ACTIVE','EUR') ON CONFLICT(id) DO NOTHING`,[relation,buyerCompany,sellerCompany,supplier]);
  await pool.query(`INSERT INTO fournisseur_catalogue(id,fournisseur_id,type,article_id,designation,reference_fournisseur,unite,prix_unitaire,devise,actif)
    VALUES($1,$2,'AUTRE',$3,'TEST fournisseur CRP','TEST-CRP-001','u',70,'EUR',true) ON CONFLICT(id) DO UPDATE SET article_id=EXCLUDED.article_id`,[catalogue,supplier,article]);
  await pool.query(`INSERT INTO intercompany_commercial_catalogue(id,relation_id,local_role,local_article_id,supplier_catalogue_id,supplier_catalogue_mapping_id,supplier_mapping_version,supplier_article_id,supplier_reference,designation,unit,buyer_sale_unit_price,buyer_sale_vat_rate,purchase_unit_price,purchase_vat_rate,currency,active)
    VALUES($1,$2,'BUYER',$3,$4,$5,1,$3,'TEST-CRP-001','TEST article dropship','u',120,20,70,20,'EUR',true) ON CONFLICT(id) DO UPDATE SET local_article_id=EXCLUDED.local_article_id,supplier_article_id=EXCLUDED.supplier_article_id`,[mapping,relation,article,catalogue,mapping]);
}
async function seedSeller(pool: Pool) {
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
async function seedSellerShipmentStock(pool: Pool) {
  // Explicitly TEST-only OLD provenance: it has a real persisted lot, balance and
  // historical document reference, so the native OLD -> NEW policy may reserve it.
  await pool.query(`INSERT INTO warehouses(id,code,name) VALUES($1,'E2E-EC-OLD','TEST EC historical stock') ON CONFLICT(id) DO UPDATE SET code=EXCLUDED.code,name=EXCLUDED.name`, [stockWarehouse]);
  await pool.query(`INSERT INTO locations(id,warehouse_id,code,description) VALUES($1,$2,'E2E-EC-OLD','TEST EC historical location') ON CONFLICT(id) DO UPDATE SET warehouse_id=EXCLUDED.warehouse_id`, [stockLocation,stockWarehouse]);
  await pool.query(`INSERT INTO magasins(id,code,name,is_active,code_magasin,libelle,actif,warehouse_id,stock_scope) VALUES($1,'E2E-EC-OLD','TEST EC historical store',true,'E2E-EC-OLD','TEST EC historical store',true,$2,'OLD') ON CONFLICT(id) DO UPDATE SET warehouse_id=EXCLUDED.warehouse_id,stock_scope='OLD',actif=true,is_active=true`,[stockMagasin,stockWarehouse]);
  await pool.query(`INSERT INTO emplacements(id,magasin_id,code,name,is_active,location_id,location_type,allow_inbound,allow_outbound) VALUES(900145,$1,'E2E-EC-OLD','TEST EC historical bin',true,$2,'STORAGE',true,true) ON CONFLICT(id) DO UPDATE SET magasin_id=EXCLUDED.magasin_id,location_id=EXCLUDED.location_id,is_active=true,allow_outbound=true`,[stockMagasin,stockLocation]);
  await pool.query(`INSERT INTO pieces_techniques(id,client_id,name_piece,code_piece,designation,statut,en_fabrication,root_piece_technique_id,version_number,piece_critique) VALUES('21000000-0000-4000-8000-000000000145','901','TEST EC piece','TEST-EC-PT','TEST EC shipment article','ACTIVE',true,'21000000-0000-4000-8000-000000000145',1,false) ON CONFLICT(id) DO UPDATE SET statut='ACTIVE',deleted_at=NULL`);
  await pool.query(`INSERT INTO articles(id,code,designation,article_type,piece_technique_id,unite,lot_tracking,is_active,article_category,stock_managed,family_code,root_article_id,version_number,plan_index,status,is_sold,row_version) VALUES($1,'TEST-EC-ARTICLE','TEST EC shipment article','PIECE_TECHNIQUE','21000000-0000-4000-8000-000000000145','u',true,true,'fabrique',true,'piece_finie',$1,1,1,'VALIDE',true,1) ON CONFLICT(id) DO UPDATE SET piece_technique_id=EXCLUDED.piece_technique_id,unite='u',status='VALIDE',is_active=true`,[article]);
  await pool.query(`INSERT INTO lots(id,article_id,lot_code,lot_status,source_scope,origin_stock_scope) VALUES($1,$2,'TEST-EC-OLD-145','LIBERE','OLD','OLD') ON CONFLICT(id) DO UPDATE SET lot_status='LIBERE',source_scope='OLD',origin_stock_scope='OLD'`,[stockLot,article]);
  await pool.query(`INSERT INTO stock_levels(id,article_id,unit_id,warehouse_id,location_id,managed_in_stock,qty_total,qty_reserved,qty_depreciated) SELECT $1,$2,u.id,$3,$4,true,2,0,0 FROM units u WHERE u.code='u' ON CONFLICT(id) DO UPDATE SET qty_total=2,qty_reserved=0,qty_depreciated=0`,[stockLevel,article,stockWarehouse,stockLocation]);
  await pool.query(`INSERT INTO stock_batches(id,stock_level_id,batch_code,qty_total,qty_reserved,qty_depreciated,lot_id) VALUES($1,$2,'TEST-EC-OLD-145',2,0,0,$3) ON CONFLICT(id) DO UPDATE SET qty_total=2,qty_reserved=0,qty_depreciated=0,lot_id=EXCLUDED.lot_id`,[stockBatch,stockLevel,stockLot]);
  await pool.query(`INSERT INTO old_stock_document_references(lot_id,type,label,location,reason,created_by,idempotency_key,request_hash) VALUES($1,'CERTIFICAT_MP','TEST EC historical certificate','fixture://intercompany-1454','TEST-only historical quality provenance',1,'42000000-0000-4000-8000-000000000145',$2) ON CONFLICT DO NOTHING`,[stockLot,'a'.repeat(64)]);
}

async function main() {
  const buyer=new Pool({connectionString:buyerUrl}); const seller=new Pool({connectionString:sellerUrl});
  try {
    await seedBuyer(buyer); await seedSeller(seller);
    process.env.CERP_BUSINESS_COMPANIES_ENABLED='true'; process.env.CERP_SHARED_DIRECTORY_ENABLED='true'; process.env.CERP_COMPANY_ID=buyerCompany; process.env.CERP_COMPANY_ENVIRONMENT='cerp_test';
    const client=await buyer.connect(); let created:{id:number;numero:string};
    try { await client.query('BEGIN'); created=await repoCreateCommandeNativeTx(client,{client_id:'901',code_client:'E2E-CLIENT-901',date_commande:'2026-10-27',order_type:'FERME',fulfilment_mode:'SUPPLIER_DROPSHIP',intercompany_delivery_address:{recipient_name:'TEST final customer',address_lines:['1 rue Fixture TEST','69001 Lyon'],country_code:'FR',contact_name:null,contact_phone:null} as never,total_ht:240,total_ttc:288,lignes:[{article_id:article,intercompany_catalogue_mapping_id:mapping,designation:'TEST article dropship',quantite:2,unite:'u',prix_unitaire_ht:120,taux_tva:20}]},1); await client.query('COMMIT'); } catch(e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    const queued=await buyer.query<{message:IntercompanyMessage}>("SELECT message FROM cerp_intercompany_outbox WHERE kind='PURCHASE_SUBMITTED' ORDER BY created_at DESC LIMIT 1"); const message=queued.rows[0]?.message; if(!message) throw new Error('PURCHASE_SUBMITTED outbox message absent');
    // Decision-side helpers resolve the local company from the runtime env.
    // The SQL work below remains on the explicit seller pool.
    process.env.CERP_COMPANY_ID=sellerCompany;
    const receipt=await receiveIntercompanyMessage(seller,message,{PURCHASE_SUBMITTED:applyPurchaseSubmittedTx});
    const pending=await seller.query<{id:string;version:number}>("SELECT id::text,version FROM cerp_intercompany_requests WHERE buyer_purchase_order_id=$1",[message.aggregate_id]); const request=pending.rows[0]; if(!request) throw new Error('seller request absent');
    const result=await decideIntercompanyRequest(seller,{company_id:sellerCompany,environment:'cerp_test',profile:'INDUSTRIAL',module_keys:['commandes-clients']} as never,1,request.id,{action:'ACCEPT',expected_version:Number(request.version),idempotency_key:'66666666-6666-4666-8666-666666666666'});
    await seedSellerShipmentStock(seller);
    const sellerOrderId = String(result.supplier_sales_order_id);
    // The process was launched seller-scoped before imports: these are the real
    // command, reservation, BL preparation and shipment repositories.
    await repoRunCommandeWorkflowAction(sellerOrderId,{action:'check_stock'} as never,1,'Administrateur Systeme et Reseau');
    await repoGenerateAffairesFromOrder(sellerOrderId,{decision:null,livraison_count:1,lines:[]} as never,{user_id:1,user_role:'Administrateur Systeme et Reseau',ip:null,user_agent:null,device_type:null,os:null,browser:null,path:null,page_key:'e2e.intercompany',client_session_id:null});
    const delivery=await repoCreateLivraisonFromCommande(Number(sellerOrderId),1);
    const ar=await svcGenerateCommandeAr({commande_id:Number(sellerOrderId),user_id:1,user_role:'Administrateur Systeme et Reseau',idempotency_key:delivery.id});
    await svcSendCommandeAr({commande_id:Number(sellerOrderId),user_id:1,user_role:'Administrateur Systeme et Reseau',body:{ar_id:ar.ar_id,recipient_emails:['fixture@example.invalid'],recipient_contact_ids:[],idempotency_key:delivery.id,email_body:null,message:null} as never});
    const reservation=(await seller.query<{id:string}>(`SELECT reservation.id::text AS id FROM stock_reservations reservation JOIN bon_livraison_ligne line ON line.id=reservation.bon_livraison_ligne_id WHERE line.bon_livraison_id=$1::uuid AND reservation.status='ACTIVE' LIMIT 1`,[delivery.id])).rows[0]?.id;
    if(!reservation) throw new Error('TEST seller reservation absent');
    await repoVerifyPreparationLot({reservation_id:reservation,qty:2,scanned_lot_code:'TEST-EC-OLD-145'} as never,1);
    const shipmentPreview=await repoGetLivraisonShipmentPreview(delivery.id);
    if(!shipmentPreview?.quality_release || shipmentPreview.quality_release.state!=='READY') throw new Error(`TEST seller quality release is not ready: ${shipmentPreview?.quality_release?.state ?? 'missing'}`);
    await repoFreezeDeliveryQualityDossier({bonLivraisonId:delivery.id,expectedPreviewSha256:shipmentPreview.quality_release.preview_sha256,reason:'TEST historical OLD quality dossier',actorUserId:1,idempotencyKey:delivery.id});
    await svcGenerateLivraisonPack({bonLivraisonId:delivery.id,actorUserId:1,body:{quality_preview_sha256:shipmentPreview.quality_release.preview_sha256,include_documents:false} as never});
    const readyPreview=await repoGetLivraisonShipmentPreview(delivery.id);
    if(!readyPreview?.can_ship) throw new Error(`TEST seller BL remains blocked after native preparation and pack: ${JSON.stringify(readyPreview?.blockers ?? [])}`);
    await repoShipLivraison(delivery.id,{expected_version:readyPreview.row_version,preview_hash:readyPreview.preview_hash,commentaire:'TEST EC shipment'} as never,1,delivery.id);
    const dispatched=(await seller.query<{message:IntercompanyMessage}>("SELECT message FROM cerp_intercompany_outbox WHERE kind='SHIPMENT_DISPATCHED' ORDER BY created_at DESC LIMIT 1")).rows[0]?.message;
    if(!dispatched) throw new Error('SHIPMENT_DISPATCHED outbox message absent');
    const snapshot=dispatched.payload as { document:{id:string}; lines:Array<{quantity:number}> };
    if(snapshot.lines.reduce((sum,line)=>sum+Number(line.quantity),0)!==2) throw new Error('shipment snapshot is not complete');
    const decision=(await seller.query<{message:IntercompanyMessage}>("SELECT message FROM cerp_intercompany_outbox WHERE kind='ORDER_DECIDED' ORDER BY created_at DESC LIMIT 1")).rows[0]?.message; if(!decision) throw new Error('ORDER_DECIDED outbox message absent');
    process.env.CERP_COMPANY_ID=buyerCompany;
    const acknowledgement=await receiveIntercompanyMessage(buyer,decision,{ORDER_DECIDED:applyCommercialIntercompanyMessageTx});
    const replay=await receiveIntercompanyMessage(buyer,decision,{ORDER_DECIDED:applyCommercialIntercompanyMessageTx});
    const fulfilment=await receiveIntercompanyMessage(buyer,dispatched,{SHIPMENT_DISPATCHED:applyIntercompanyFulfilmentMessageTx});
    const fulfilmentReplay=await receiveIntercompanyMessage(buyer,dispatched,{SHIPMENT_DISPATCHED:applyIntercompanyFulfilmentMessageTx});
    const receiptCount=await buyer.query<{count:string}>("SELECT count(*)::text AS count FROM cerp_intercompany_external_fulfilment_receipts WHERE message_id=$1",[dispatched.id]);
    const buyerStatus=await buyer.query<{statut:string}>("SELECT statut FROM commande_client WHERE id=$1",[created!.id]);
    if(receiptCount.rows[0]?.count!=='1'||buyerStatus.rows[0]?.statut!=='LIVRE') throw new Error('buyer receipt did not complete dropship delivery exactly once');
    const linked=await buyer.query<{supplier_order_state:string;supplier_sales_order_id:string}>("SELECT supplier_order_state,supplier_sales_order_id FROM intercompany_purchase_order_links WHERE buyer_sales_order_id=$1",[created!.id]); if(linked.rows[0]?.supplier_order_state!=='ACCEPTED') throw new Error('buyer decision projection absent');
    console.log(JSON.stringify({buyer_order:created!,outbox_kind:message.kind,seller_receipt:receipt.status,seller_request:result.state,seller_order:result.supplier_sales_order_id,seller_delivery:delivery.id,shipment_receipt:snapshot.document.id,buyer_acknowledgement:acknowledgement.status,buyer_replay:replay.status,fulfilment:fulfilment.status,fulfilment_replay:fulfilmentReplay.status}));
  } finally { await buyer.end(); await seller.end(); }
}
main().catch(error=>{console.error(error instanceof Error?error.stack:error);process.exitCode=1});
