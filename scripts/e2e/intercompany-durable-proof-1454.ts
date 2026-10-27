import { Pool } from "pg";

function fixtureUrl(role: "BUYER" | "SELLER") {
  const value = process.env[`CERP_E2E_${role}_DATABASE_URL`];
  if (!value) throw new Error(`FIXTURE_${role}_URL_REQUIRED`);
  const parsed = new URL(value);
  if (parsed.hostname !== "127.0.0.1" || parsed.port !== "15464" ||
      parsed.pathname !== `/cerp_ec1454_${role.toLowerCase()}_v2`)
    throw new Error("OWNED_V2_FIXTURE_ONLY");
  return value;
}

async function main() {
  const buyer = new Pool({ connectionString: fixtureUrl("BUYER") });
  const seller = new Pool({ connectionString: fixtureUrl("SELLER") });
  try {
    const receipt = (await buyer.query<{
      message_id: string; seller_delivery_id: string; buyer_sales_order_id: string; document_id: string;
    }>(`SELECT message_id::text, seller_delivery_id, buyer_sales_order_id::text, document_id
        FROM cerp_intercompany_external_fulfilment_receipts
        ORDER BY received_at DESC LIMIT 1`)).rows[0];
    if (!receipt) throw new Error("EXTERNAL_RECEIPT_NOT_PERSISTED");
    const shipment = (await seller.query<{ status: string; posted: string }>(`
      SELECT bl.statut AS status, count(m.id)::text AS posted
      FROM bon_livraison bl LEFT JOIN stock_movements m
        ON m.source_document_id=bl.id::text AND m.status='POSTED'
      WHERE bl.id=$1::uuid GROUP BY bl.statut`, [receipt.seller_delivery_id])).rows[0];
    const workflow = (await buyer.query<{ status: string }>(`
      SELECT nouveau_statut AS status FROM commande_historique
      WHERE commande_id=$1 ORDER BY date_action DESC,id DESC LIMIT 1`,
    [receipt.buyer_sales_order_id])).rows[0];
    const quantity = (await buyer.query<{ quantity: string; count: string }>(`
      SELECT coalesce(sum(quantity),0)::text AS quantity, count(*)::text AS count
      FROM cerp_intercompany_external_fulfilment_receipt_lines WHERE message_id=$1::uuid`,
    [receipt.message_id])).rows[0];
    const document = (await seller.query<{ issuer: string; recipient: string; archived: boolean }>(`
      SELECT source_snapshot->'issuer'->>'company_name' AS issuer,
             source_snapshot->>'client_name' AS recipient, archived_at IS NOT NULL AS archived
      FROM authoritative_pdf_archives WHERE id=$1::uuid`, [receipt.document_id])).rows[0];
    if (shipment?.status !== "SHIPPED" || shipment.posted !== "1" ||
        workflow?.status !== "LIVRE" || !quantity || Number(quantity.quantity) <= 0)
      throw new Error("DURABLE_SHIPMENT_PROOF_INCOMPLETE");
    process.stdout.write(`READ_ONLY_DURABLE_PROOF ${JSON.stringify({
      receipt_message: receipt.message_id,
      seller_delivery: receipt.seller_delivery_id,
      seller_status: shipment.status,
      posted_stock_movements: shipment.posted,
      buyer_order: receipt.buyer_sales_order_id,
      buyer_workflow: workflow.status,
      receipt_lines: quantity.count,
      proved_quantity: quantity.quantity,
      document_issuer: document?.issuer ?? null,
      document_recipient: document?.recipient ?? null,
      document_archived: document?.archived ?? false,
    })}\n`);
  } finally {
    await Promise.all([buyer.end(), seller.end()]);
  }
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : "DURABLE_PROOF_FAILED"}\n`);
  process.exitCode = 1;
});
