import { Pool } from "pg";

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function expectedAmount(name: string, fallback: number) {
  const raw = argument(name);
  if (raw === undefined) return fallback;
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw) || Number(raw) <= 0) throw new Error(`INVALID_${name}`);
  return Number(raw);
}

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
        WHERE ($1::uuid IS NULL OR message_id=$1::uuid)
        ORDER BY received_at DESC LIMIT 1`, [argument("--receipt") ?? null])).rows[0];
    if (!receipt) throw new Error("EXTERNAL_RECEIPT_NOT_PERSISTED");
    const shipment = (await seller.query<{ status: string; posted: string; destination: { recipient_name?: string; address_line_1?: string; postal_code?: string; city?: string } | null }>(`
      SELECT bl.statut AS status, count(m.id)::text AS posted,
             bl.intercompany_destination_snapshot AS destination
      FROM bon_livraison bl LEFT JOIN stock_movements m
        ON m.source_document_id=bl.id::text AND m.status='POSTED'
      WHERE bl.id=$1::uuid GROUP BY bl.id`, [receipt.seller_delivery_id])).rows[0];
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
        workflow?.status !== "LIVRE" || !quantity || Number(quantity.quantity) <= 0 ||
        !shipment.destination?.recipient_name || !shipment.destination.address_line_1 ||
        !shipment.destination.postal_code || !shipment.destination.city)
      throw new Error("DURABLE_SHIPMENT_PROOF_INCOMPLETE");
    const invoices: Record<string, unknown> = {};
    for (const [role, db, ht, ttc] of [
      ["buyer", buyer, expectedAmount("--buyer-ht", 240), expectedAmount("--buyer-ttc", 288)],
      ["seller", seller, expectedAmount("--seller-ht", 140), expectedAmount("--seller-ttc", 168)],
    ] as const) {
      const sourceType = role === "buyer" ? "EXTERNAL_FULFILMENT_RECEIPT_LINE" : "DELIVERY_LINE";
      const sourceId = role === "buyer" ? receipt.message_id : receipt.seller_delivery_id;
      const invoice = (await db.query<{ id: string; legal_number: string; issuer: string; customer: string; total_ht: string; total_ttc: string; archived: boolean; consumed_quantity: string }>(`
        SELECT f.id::text,f.legal_number,f.issuer_snapshot->>'company_name' AS issuer,
               f.client_snapshot->>'company_name' AS customer,
               f.total_ht::text,f.total_ttc::text,
               (SELECT sum(s.quantity_consumed)::text FROM facture_source_allocations s
                WHERE s.facture_id=f.id AND s.source_type=$1 AND s.source_id=$2
                  AND s.allocation_status='CONSUMED') AS consumed_quantity,
               EXISTS(SELECT 1 FROM authoritative_pdf_archives a WHERE a.entity_type='facture'
                 AND a.entity_id=f.uuid::text AND a.document_kind='FINANCE_INVOICE_LEGAL_PDF'
                 AND a.archived_at IS NOT NULL AND a.pdf_sha256 IS NOT NULL) AS archived
        FROM facture f WHERE f.statut='ISSUED' AND EXISTS(
          SELECT 1 FROM facture_source_allocations s WHERE s.facture_id=f.id
            AND s.source_type=$1 AND s.source_id=$2 AND s.allocation_status='CONSUMED')
        ORDER BY f.id DESC LIMIT 1`, [sourceType, sourceId])).rows[0];
      if (!invoice || Number(invoice.total_ht) !== ht || Number(invoice.total_ttc) !== ttc || !invoice.archived ||
          Number(invoice.consumed_quantity) !== Number(quantity.quantity))
        throw new Error(`DURABLE_${role.toUpperCase()}_INVOICE_PROOF_INCOMPLETE`);
      invoices[role] = invoice;
    }
    const buyerStock = (await buyer.query<{ count: string }>("SELECT count(*)::text AS count FROM stock_movements")).rows[0];
    if (buyerStock?.count !== "0") throw new Error("BUYER_MUST_NOT_HAVE_LOCAL_STOCK_MOVEMENTS");
    process.stdout.write(`READ_ONLY_DURABLE_PROOF ${JSON.stringify({
      receipt_message: receipt.message_id,
      seller_delivery: receipt.seller_delivery_id,
      seller_status: shipment.status,
      posted_stock_movements: shipment.posted,
      buyer_stock_movements: buyerStock.count,
      buyer_order: receipt.buyer_sales_order_id,
      buyer_workflow: workflow.status,
      receipt_lines: quantity.count,
      proved_quantity: quantity.quantity,
      document_issuer: document?.issuer ?? null,
      document_recipient: document?.recipient ?? null,
      document_archived: document?.archived ?? false,
      native_delivery_destination: shipment.destination,
      invoices,
    })}\n`);
  } finally {
    await Promise.all([buyer.end(), seller.end()]);
  }
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : "DURABLE_PROOF_FAILED"}\n`);
  process.exitCode = 1;
});
