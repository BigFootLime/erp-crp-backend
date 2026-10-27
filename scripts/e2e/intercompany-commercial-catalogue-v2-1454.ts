/* TEST-only published-v2 catalogue qualification; run seller-scoped via the private fixture launcher. */
import { Pool } from "pg";
import crypto from "node:crypto";
import globalPool from "../../src/config/database";
import { repoCreateSupplierOfferTx, repoPublishSupplierCatalogueTx, repoCreateCommercialCatalogueTx } from "../../src/module/entreprises/intercompany/commercial-catalogue.repository";
import { receiveIntercompanyMessage } from "../../src/module/entreprises/intercompany/intercompany-inbox.repository";
import { applyCommercialIntercompanyMessageTx } from "../../src/module/entreprises/intercompany/commercial-intercompany-message.repository";
import { repoCreateCommandeNativeTx, repoGenerateAffairesFromOrder, repoRunCommandeWorkflowAction } from "../../src/module/commande-client/repository/commande-client.repository";
import { applyPurchaseSubmittedTx, decideIntercompanyRequest } from "../../src/module/entreprises/intercompany/intercompany-requests.repository";
import type { IntercompanyMessage } from "../../src/module/entreprises/intercompany/intercompany-message";

const buyerUrl = process.env.CERP_E2E_BUYER_DATABASE_URL;
const sellerUrl = process.env.CERP_E2E_SELLER_DATABASE_URL;
if (!buyerUrl || !sellerUrl) throw new Error("TEST fixture database URLs are required");
const buyerCompany = "11111111-1111-4111-8111-111111111111";
const sellerCompany = "22222222-2222-4222-8222-222222222222";
const relationId = "33333333-3333-4333-8333-333333333333";
const sellerArticleId = "22000000-0000-4000-8000-000000000001";
const audit = { user_id: 1, ip: null, user_agent: null, device_type: null, os: null, browser: null, path: "e2e.intercompany-catalogue-v2", page_key: "e2e.intercompany-catalogue-v2", client_session_id: null };

async function main() {
  const buyer = new Pool({ connectionString: buyerUrl });
  const seller = new Pool({ connectionString: sellerUrl });
  try {
    const [buyerDb, sellerDb, globalDb] = await Promise.all([
      buyer.query<{ database: string }>("SELECT current_database() AS database"),
      seller.query<{ database: string }>("SELECT current_database() AS database"),
      globalPool.query<{ database: string }>("SELECT current_database() AS database"),
    ]);
    if (buyerDb.rows[0]?.database !== "cerp_ec1454_buyer_v2" || sellerDb.rows[0]?.database !== "cerp_ec1454_seller_v2" || globalDb.rows[0]?.database !== "cerp_ec1454_seller_v2") {
      throw new Error("TEST database scope mismatch; launch this helper with --database seller_v2");
    }
    const suffix = crypto.randomUUID().slice(0, 8).toUpperCase();
    const sellerTx = await seller.connect();
    let published: Awaited<ReturnType<typeof repoPublishSupplierCatalogueTx>>;
    try {
      await sellerTx.query("BEGIN");
      const offer = await repoCreateSupplierOfferTx(sellerTx, sellerCompany, {
        relation_id: relationId, local_article_id: sellerArticleId, designation: `TEST Bride CRP v2 ${suffix}`,
        unit: "u", variant_code: `INOX-316-V2-${suffix}`, options_snapshot: { finition: "brossée", revision: 2 },
        supplier_sale_unit_price: 85.5, purchase_vat_rate: 20, currency: "EUR",
      }, 1);
      published = await repoPublishSupplierCatalogueTx(sellerTx, sellerCompany, String(offer.id));
      await sellerTx.query("COMMIT");
    } catch (error) { await sellerTx.query("ROLLBACK"); throw error; } finally { sellerTx.release(); }
    const outbound = await seller.query<{ message: IntercompanyMessage }>("SELECT message FROM cerp_intercompany_outbox WHERE aggregate_id=$1 AND kind='CATALOGUE_PUBLISHED' ORDER BY created_at DESC LIMIT 1", [published.supplier_catalogue_mapping_id]);
    const message = outbound.rows[0]?.message;
    if (!message) throw new Error("TEST published catalogue outbox message absent");
    await receiveIntercompanyMessage(buyer, message, { CATALOGUE_PUBLISHED: applyCommercialIntercompanyMessageTx });

    const buyerTx = await buyer.connect();
    let mapped: Awaited<ReturnType<typeof repoCreateCommercialCatalogueTx>>;
    try {
      await buyerTx.query("BEGIN");
      mapped = await repoCreateCommercialCatalogueTx(buyerTx, buyerCompany, {
        relation_id: relationId, local_article: { designation: published.designation, family_code: "ACHAT", unit: published.unit },
        supplier_catalogue_mapping_id: published.supplier_catalogue_mapping_id, supplier_mapping_version: published.supplier_mapping_version,
        supplier_article_id: published.supplier_article_id, supplier_piece_technique_id: published.supplier_piece_technique_id,
        supplier_piece_technique_version_id: published.supplier_piece_technique_version_id, supplier_reference: published.supplier_reference,
        designation: published.designation, unit: published.unit, variant_code: published.variant_code, options_snapshot: published.options_snapshot,
        buyer_sale_unit_price: 149.5, buyer_sale_vat_rate: 20, purchase_unit_price: published.supplier_sale_unit_price,
        purchase_vat_rate: published.purchase_vat_rate, currency: published.currency,
      }, audit);
      await buyerTx.query("COMMIT");
    } catch (error) { await buyerTx.query("ROLLBACK"); throw error; } finally { buyerTx.release(); }
    const local = await buyer.query<{ article_type: string; article_category: string; stock_managed: boolean; variant_code: string; options_snapshot: Record<string, unknown>; supplier_mapping_version: number }>(
      "SELECT a.article_type,a.article_category,a.stock_managed,m.variant_code,m.options_snapshot,m.supplier_mapping_version FROM articles a JOIN intercompany_commercial_catalogue m ON m.local_article_id=a.id WHERE m.id=$1::uuid", [mapped.id]);
    const localRow = local.rows[0];
    if (!localRow || localRow.article_type !== "PURCHASED" || localRow.article_category !== "achat" || localRow.stock_managed || localRow.variant_code !== published.variant_code || localRow.supplier_mapping_version !== published.supplier_mapping_version || JSON.stringify(localRow.options_snapshot) !== JSON.stringify(published.options_snapshot)) throw new Error("TEST buyer mapping did not retain the published v2 binding");

    const commandTx = await buyer.connect();
    let buyerOrder: { id: number };
    try {
      await commandTx.query("BEGIN");
      buyerOrder = await repoCreateCommandeNativeTx(commandTx, { client_id: "901", code_client: `EC-V2-${suffix}`, date_commande: "2026-10-27", order_type: "FERME", fulfilment_mode: "SUPPLIER_DROPSHIP", total_ht: 149.5, total_ttc: 179.4, lignes: [{ article_id: mapped.local_article_id, intercompany_catalogue_mapping_id: mapped.id, designation: published.designation, quantite: 1, unite: published.unit, prix_unitaire_ht: 149.5, taux_tva: 20 }] }, 1);
      await commandTx.query("COMMIT");
    } catch (error) { await commandTx.query("ROLLBACK"); throw error; } finally { commandTx.release(); }
    const purchase = await buyer.query<{ message: IntercompanyMessage }>("SELECT message FROM cerp_intercompany_outbox WHERE kind='PURCHASE_SUBMITTED' AND message->'payload'->>'buyer_sales_order_id'=$1 ORDER BY created_at DESC LIMIT 1", [String(buyerOrder.id)]);
    const purchaseMessage = purchase.rows[0]?.message;
    if (!purchaseMessage) throw new Error("TEST EC purchase submission absent");
    process.env.CERP_COMPANY_ID = sellerCompany;
    await receiveIntercompanyMessage(seller, purchaseMessage, { PURCHASE_SUBMITTED: applyPurchaseSubmittedTx });
    const request = (await seller.query<{ id: string; version: number }>("SELECT id::text,version FROM cerp_intercompany_requests WHERE buyer_purchase_order_id=$1::uuid", [purchaseMessage.aggregate_id])).rows[0];
    if (!request) throw new Error("TEST CRP purchase request absent");
    const accepted = await decideIntercompanyRequest(seller, { company_id: sellerCompany, environment: "cerp_test", profile: "INDUSTRIAL", module_keys: ["commandes-clients"] } as never, 1, request.id, { action: "ACCEPT", expected_version: Number(request.version), idempotency_key: crypto.randomUUID() });
    const sellerOrderId = String(accepted.supplier_sales_order_id);
    const sellerMode = await seller.query<{ fulfilment_mode: string }>("SELECT fulfilment_mode FROM commande_client WHERE id=$1::bigint", [sellerOrderId]);
    if (sellerMode.rows[0]?.fulfilment_mode !== "STANDARD") throw new Error("TEST accepted CRP order is not STANDARD");
    await repoRunCommandeWorkflowAction(sellerOrderId, { action: "check_stock" } as never, 1, "Administrateur Systeme et Reseau");
    await repoGenerateAffairesFromOrder(sellerOrderId, { decision: null, livraison_count: 1, lines: [] } as never, audit);
    process.stdout.write(`E2E_COMMERCIAL_CATALOGUE_V2_PASS ${JSON.stringify({ buyer_database: buyerDb.rows[0]?.database, seller_database: sellerDb.rows[0]?.database, global_database: globalDb.rows[0]?.database, supplier_mapping_version: published.supplier_mapping_version, variant_code: published.variant_code, buyer_mapping: mapped.id, buyer_article_type: localRow.article_type, buyer_stock_managed: localRow.stock_managed, buyer_order: buyerOrder.id, seller_order: sellerOrderId, seller_fulfilment_mode: sellerMode.rows[0]?.fulfilment_mode })}\n`);
  } finally { await buyer.end(); await seller.end(); await globalPool.end(); }
}
main().catch(error => { process.stderr.write(`E2E_COMMERCIAL_CATALOGUE_V2_FAIL ${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1; });
