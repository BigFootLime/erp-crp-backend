/* Continue a published-catalogue PURCHASED order through the native CRP flow.
 * TEST-only: run seller-scoped through .codex-tmp/intercompany-e2e-1454/run-fixture-step.cjs. */
import { Pool } from "pg";
import { createServer } from "node:http";
import globalPool from "../../src/config/database";
import { repoGenerateAffairesFromOrder, repoRunCommandeWorkflowAction } from "../../src/module/commande-client/repository/commande-client.repository";
import { svcGenerateCommandeAr, svcSendCommandeAr } from "../../src/module/commande-client/services/commande-ar.service";
import { repoFindCommandeArOfficialArchiveId } from "../../src/module/commande-client/repository/commande-ar.repository";
import { applyIntercompanyFulfilmentMessageTx } from "../../src/module/entreprises/intercompany/intercompany-fulfilment.repository";
import { receiveIntercompanyMessage } from "../../src/module/entreprises/intercompany/intercompany-inbox.repository";
import { repoConfirmLivraisonPreparation, repoGetLivraisonPreparation } from "../../src/module/livraisons/repository/livraisons-preparation.repository";
import { repoCreateLivraisonFromCommande, repoGetLivraisonDetail, repoVerifyPreparationLot } from "../../src/module/livraisons/repository/livraisons.repository";
import { repoFreezeDeliveryQualityDossier } from "../../src/module/livraisons/repository/quality-dossier.repository";
import { repoGetLivraisonShipmentPreview, repoShipLivraison } from "../../src/module/livraisons/repository/livraisons-shipment.repository";
import { svcGenerateLivraisonPack } from "../../src/module/livraisons/services/pack.service";
import { runAuthoritativePdfArchiveWorkerOnce } from "../../src/shared/authoritative-documents/authoritative-document.worker";
import type { IntercompanyMessage } from "../../src/module/entreprises/intercompany/intercompany-message";

const value = (name: string) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
const sellerOrderId = value("--seller-order");
const buyerOrderId = value("--buyer-order");
if (!sellerOrderId || !buyerOrderId || !/^\d+$/.test(sellerOrderId) || !/^\d+$/.test(buyerOrderId)) throw new Error("usage: --seller-order ID --buyer-order ID");

const sellerUrl = process.env.DATABASE_URL;
const buyerUrl = process.env.CERP_E2E_BUYER_DATABASE_URL;
if (!sellerUrl || !buyerUrl) throw new Error("TEST fixture URLs are required");
for (const [name, url, database] of [["seller", sellerUrl, "cerp_ec1454_seller_v2"], ["buyer", buyerUrl, "cerp_ec1454_buyer_v2"]] as const) {
  const parsed = new URL(url);
  if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname) || parsed.port !== "15464" || parsed.pathname !== `/${database}`) throw new Error(`Unsafe ${name} fixture URL`);
}
if (process.env.CERP_COMPANY_ID !== "22222222-2222-4222-8222-222222222222" || process.env.CERP_COMPANY_ENVIRONMENT !== "cerp_test") throw new Error("Seller runtime scope is required before imports");

const actor = { user_id: 1, user_role: "Administrateur Systeme et Reseau", ip: null, user_agent: null, device_type: null, os: null, browser: null, path: "e2e.catalogue-existing", page_key: "e2e.catalogue-existing", client_session_id: null };

async function startFixtureEmailSink(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    request.resume();
    request.once("end", () => response.writeHead(request.method === "POST" && request.url === "/emails" ? 200 : 404, { "content-type": "application/json" }).end(JSON.stringify({ id: "catalogue-fixture-ar" })));
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture email sink unavailable");
  return { baseUrl: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

async function makeExistingLotAvailable(seller: Pool, articleId: string, technicalVersionId: string, quantity: string) {
  const available = await seller.query<{ lot_id: string; lot_code: string }>(`
    SELECT lot.id::text AS lot_id,lot.lot_code
      FROM stock_levels level JOIN stock_batches batch ON batch.stock_level_id=level.id
      JOIN lots lot ON lot.id=batch.lot_id
     WHERE level.article_id=$1::uuid AND lot.piece_technique_version_id=$2::uuid
       AND lot.lot_status='LIBERE' AND lot.source_scope='OLD' AND lot.stock_scope='OLD'
       AND EXISTS (SELECT 1 FROM old_stock_document_references proof WHERE proof.lot_id=lot.id)
     ORDER BY lot.id LIMIT 1`, [articleId, technicalVersionId]);
  const lot = available.rows[0];
  if (!lot) throw new Error("TEST prequalified OLD lot unavailable for published catalogue article");
  await seller.query(`UPDATE stock_levels SET qty_total=$2::numeric,qty_reserved=0,qty_depreciated=0 WHERE article_id=$1::uuid`, [articleId, quantity]);
  await seller.query(`UPDATE stock_batches SET qty_total=$2::numeric,qty_reserved=0,qty_depreciated=0 WHERE lot_id=$1::uuid`, [lot.lot_id, quantity]);
  return lot;
}

async function main() {
  const seller = new Pool({ connectionString: sellerUrl });
  const buyer = new Pool({ connectionString: buyerUrl });
  try {
    const [sellerDatabase, buyerDatabase, globalDatabase] = await Promise.all([
      seller.query<{ database: string }>("SELECT current_database() AS database"), buyer.query<{ database: string }>("SELECT current_database() AS database"), globalPool.query<{ database: string }>("SELECT current_database() AS database"),
    ]);
    if (sellerDatabase.rows[0]?.database !== "cerp_ec1454_seller_v2" || buyerDatabase.rows[0]?.database !== "cerp_ec1454_buyer_v2" || globalDatabase.rows[0]?.database !== "cerp_ec1454_seller_v2") throw new Error("Fixture database scope mismatch");
    const sellerOrder = await seller.query<{ article_id: string; quantity: string; price: string; technical_version: string; mode: string; article_type: string; stock_managed: boolean }>(`
      SELECT line.article_id::text,line.quantite::text AS quantity,line.prix_unitaire_ht::text AS price,line.piece_technique_version_id::text AS technical_version,
             order_row.fulfilment_mode AS mode,article.article_type,article.stock_managed
        FROM commande_client order_row JOIN commande_ligne line ON line.commande_id=order_row.id JOIN articles article ON article.id=line.article_id
       WHERE order_row.id=$1::bigint`, [sellerOrderId]);
    const sellerLine = sellerOrder.rows[0];
    if (!sellerLine || sellerOrder.rows.length !== 1 || sellerLine.mode !== "STANDARD" || sellerLine.article_type !== "PIECE_TECHNIQUE" || !sellerLine.stock_managed || sellerLine.quantity !== "1.000000" || sellerLine.price !== "85.5000" || !sellerLine.technical_version) throw new Error("Seller order is not the expected published-catalogue standard source");
    const buyerOrder = await buyer.query<{ article_type: string; stock_managed: boolean; quantity: string; price: string }>(`
      SELECT article.article_type,article.stock_managed,line.quantite::text AS quantity,line.prix_unitaire_ht::text AS price
        FROM commande_client order_row JOIN commande_ligne line ON line.commande_id=order_row.id JOIN articles article ON article.id=line.article_id
       WHERE order_row.id=$1::bigint`, [buyerOrderId]);
    const buyerLine = buyerOrder.rows[0];
    if (!buyerLine || buyerOrder.rows.length !== 1 || buyerLine.article_type !== "PURCHASED" || buyerLine.stock_managed || buyerLine.quantity !== "1.000000" || buyerLine.price !== "149.5000") throw new Error("Buyer order is not the expected PURCHASED catalogue source");
    const request = await seller.query<{ id: string; final_destination: { recipient_name?: string; address_lines?: string[] } }>(`SELECT id::text,final_delivery_address_snapshot AS final_destination FROM cerp_intercompany_requests WHERE supplier_sales_order_id=$1::bigint AND state='ACCEPTED'`, [sellerOrderId]);
    const requestRow = request.rows[0];
    if (!requestRow?.final_destination?.recipient_name || !requestRow.final_destination.address_lines?.length) throw new Error("Accepted request has no immutable final destination");
    const lot = await makeExistingLotAvailable(seller, sellerLine.article_id, sellerLine.technical_version, "1");
    await repoRunCommandeWorkflowAction(sellerOrderId, { action: "check_stock" } as never, 1, actor.user_role);
    await repoGenerateAffairesFromOrder(sellerOrderId, { decision: null, livraison_count: 1, lines: [] } as never, actor);
    // Continue only the checkpoints which the native stock decision made
    // active. A fully stocked order skips planning/OF; a shortage follows the
    // industrial path and is intentionally not shortcut by this fixture.
    const activeCheckpoint = async () => (await seller.query<{ checkpoint_code: string }>("SELECT checkpoint_code FROM commande_client_workflow_checkpoint WHERE commande_id=$1::bigint AND status='active' ORDER BY sort_order LIMIT 1", [sellerOrderId])).rows[0]?.checkpoint_code;
    if (await activeCheckpoint() === "planning_validation") await repoRunCommandeWorkflowAction(sellerOrderId, { action: "validate_planning" } as never, 1, actor.user_role);
    if (await activeCheckpoint() === "ar_preparation") await repoRunCommandeWorkflowAction(sellerOrderId, { action: "prepare_ar" } as never, 1, actor.user_role);
    if (await activeCheckpoint() !== "ar_sent") throw new Error(`Unexpected native checkpoint after stocked launch: ${await activeCheckpoint() ?? "none"}`);
    const existingDelivery = await seller.query<{ id: string }>("SELECT id::text FROM bon_livraison WHERE commande_id=$1::bigint AND statut='DRAFT' ORDER BY created_at DESC LIMIT 1", [sellerOrderId]);
    const delivery = existingDelivery.rows[0] ? { id: existingDelivery.rows[0].id } : await repoCreateLivraisonFromCommande(Number(sellerOrderId), 1);
    const nativeBefore = await repoGetLivraisonDetail(delivery.id);
    const address = nativeBefore?.bon_livraison.adresse_livraison;
    if (!address || address.name !== requestRow.final_destination.recipient_name || !requestRow.final_destination.address_lines.every((line) => address.label.includes(line))) throw new Error("Native BL does not use immutable final destination");
    const persistedAr = await seller.query<{ id: string; status: string }>("SELECT id::text,status FROM commande_ar_log WHERE commande_id=$1::bigint ORDER BY version_number DESC,generated_at DESC LIMIT 1", [sellerOrderId]);
    let arId = persistedAr.rows[0]?.id;
    let arSent = persistedAr.rows[0]?.status === "SENT";
    if (!arId) {
      const ar = await svcGenerateCommandeAr({ commande_id: Number(sellerOrderId), user_id: 1, user_role: actor.user_role, idempotency_key: delivery.id });
      arId = ar.ar_id;
    }
    let arArchiveId: string | null = null;
    for (let attempt = 0; attempt < 20 && !arArchiveId; attempt += 1) { await runAuthoritativePdfArchiveWorkerOnce(undefined, `catalogue-fixture-pdf:${process.pid}`); arArchiveId = await repoFindCommandeArOfficialArchiveId(Number(sellerOrderId), arId); }
    if (!arArchiveId) throw new Error("Native AR archive unavailable");
    if (!arSent) {
      const emailSink = await startFixtureEmailSink();
      try {
        process.env.CERP_E2E_EMAIL_SINK = "1";
        process.env.RESEND_API_KEY = "fixture-local-only";
        process.env.RESEND_FROM = "sender@example.local";
        process.env.RESEND_API_BASE_URL = emailSink.baseUrl;
        await svcSendCommandeAr({ commande_id: Number(sellerOrderId), user_id: 1, user_role: actor.user_role, body: { ar_id: arId, recipient_emails: ["fixture@example.local"], recipient_contact_ids: [], idempotency_key: delivery.id, email_body: null, message: null } as never });
        arSent = true;
      } finally { await emailSink.close(); }
    }
    if (!arSent) throw new Error("Native AR was not sent");
    const reservation = await seller.query<{ id: string }>(`SELECT reservation.id::text FROM stock_reservations reservation JOIN bon_livraison_ligne line ON line.id=reservation.bon_livraison_ligne_id WHERE line.bon_livraison_id=$1::uuid AND reservation.status='ACTIVE'`, [delivery.id]);
    if (!reservation.rows[0]) throw new Error("Native delivery reservation absent");
    await repoVerifyPreparationLot({ reservation_id: reservation.rows[0].id, qty: 1, scanned_lot_code: lot.lot_code } as never, 1);
    const preparation = await repoGetLivraisonPreparation(delivery.id);
    const task = preparation?.tasks.find((entry) => entry.reservation_status === "ACTIVE" && entry.lot_code === lot.lot_code);
    if (!preparation || !task?.can_confirm) throw new Error("Native preparation cannot be confirmed");
    await repoConfirmLivraisonPreparation(delivery.id, task.allocation_id, { expected_version: preparation.row_version, input_method: "SCANNER", scan_code: lot.lot_code } as never, 1, `${delivery.id}:pick`);
    const quality = await repoGetLivraisonShipmentPreview(delivery.id);
    if (quality?.quality_release?.state !== "READY") throw new Error("Native quality release unavailable");
    await repoFreezeDeliveryQualityDossier({ bonLivraisonId: delivery.id, expectedPreviewSha256: quality.quality_release.preview_sha256, reason: "TEST catalogue published article", actorUserId: 1, idempotencyKey: delivery.id });
    await svcGenerateLivraisonPack({ bonLivraisonId: delivery.id, actorUserId: 1, body: { quality_preview_sha256: quality.quality_release.preview_sha256, include_documents: false } as never });
    const ready = await repoGetLivraisonShipmentPreview(delivery.id);
    if (!ready?.can_ship) throw new Error(`Native shipment still blocked: ${JSON.stringify(ready?.blockers ?? [])}`);
    await repoShipLivraison(delivery.id, { expected_version: ready.row_version, preview_hash: ready.preview_hash, commentaire: "TEST catalogue published shipment" } as never, 1, delivery.id);
    const after = await repoGetLivraisonDetail(delivery.id);
    if (after?.bon_livraison.adresse_livraison.label !== address.label) throw new Error("Native BL destination changed during shipment");
    const message = await seller.query<{ message: IntercompanyMessage }>(`SELECT message FROM cerp_intercompany_outbox WHERE kind='SHIPMENT_DISPATCHED' AND aggregate_id=$1 ORDER BY created_at DESC LIMIT 1`, [`${requestRow.id}:${delivery.id}`]);
    const shipment = message.rows[0]?.message;
    if (!shipment) throw new Error("Native SHIPMENT_DISPATCHED outbox message absent");
    const beforeBuyerStock = await buyer.query<{ count: string }>("SELECT count(*)::text AS count FROM stock_movements");
    await receiveIntercompanyMessage(buyer, shipment, { SHIPMENT_DISPATCHED: applyIntercompanyFulfilmentMessageTx });
    await receiveIntercompanyMessage(buyer, shipment, { SHIPMENT_DISPATCHED: applyIntercompanyFulfilmentMessageTx });
    const [receipt, buyerStatus, afterBuyerStock, deliveryLine] = await Promise.all([
      buyer.query<{ count: string }>("SELECT count(*)::text AS count FROM cerp_intercompany_external_fulfilment_receipts WHERE message_id=$1", [shipment.id]),
      buyer.query<{ status: string }>("SELECT nouveau_statut AS status FROM commande_historique WHERE commande_id=$1::bigint ORDER BY date_action DESC,id DESC LIMIT 1", [buyerOrderId]),
      buyer.query<{ count: string }>("SELECT count(*)::text AS count FROM stock_movements"),
      seller.query<{ id: string }>("SELECT id::text FROM bon_livraison_ligne WHERE bon_livraison_id=$1::uuid", [delivery.id]),
    ]);
    if (receipt.rows[0]?.count !== "1" || buyerStatus.rows[0]?.status !== "LIVRE" || beforeBuyerStock.rows[0]?.count !== afterBuyerStock.rows[0]?.count || !deliveryLine.rows[0]) throw new Error("Buyer receipt assertion failed");
    process.stdout.write(`E2E_CATALOGUE_DELIVERY_PASS ${JSON.stringify({ buyer_order: buyerOrderId, seller_order: sellerOrderId, seller_delivery: delivery.id, seller_delivery_line: deliveryLine.rows[0].id, shipment_message: shipment.id, shipment_document: shipment.payload.document.id, ar_official_archive: arArchiveId, buyer_status: buyerStatus.rows[0].status, receipt_count: receipt.rows[0].count, buyer_stock_movements_before: beforeBuyerStock.rows[0].count, buyer_stock_movements_after: afterBuyerStock.rows[0].count, native_destination: address.label })}\n`);
  } finally { await seller.end(); await buyer.end(); await globalPool.end(); }
}
main().catch((error) => { process.stderr.write(`E2E_CATALOGUE_DELIVERY_FAIL ${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1; });
