/* Synthetic two-company qualification. All IDs, identities and prices are TEST-only. */
import { Pool } from "pg";
import { repoCreateCommandeNativeTx } from "../../src/module/commande-client/repository/commande-client.repository";
import { receiveIntercompanyMessage } from "../../src/module/entreprises/intercompany/intercompany-inbox.repository";
import { applyPurchaseSubmittedTx, decideIntercompanyRequest } from "../../src/module/entreprises/intercompany/intercompany-requests.repository";
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
    console.log(JSON.stringify({buyer_order:created!,outbox_kind:message.kind,seller_receipt:receipt.status,seller_request:result.state,seller_order:result.supplier_sales_order_id}));
  } finally { await buyer.end(); await seller.end(); }
}
main().catch(error=>{console.error(error instanceof Error?error.stack:error);process.exitCode=1});
