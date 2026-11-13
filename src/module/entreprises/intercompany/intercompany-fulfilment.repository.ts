import type { PoolClient } from "pg";
import { z } from "zod";

import { HttpError } from "../../../utils/httpError";
import { repoEnsureCommandeWorkflowStatus } from "../../commande-client/repository/commande-client.repository";
import { loadCommandeFulfillmentState } from "../../commande-client/repository/commande-fulfillment-guards.repository";
import type { IntercompanyMessage } from "./intercompany-message";

type Queryable = Pick<PoolClient, "query">;

const uuid = z.string().uuid();
const quantity = z.coerce.number().finite().positive();
const nativeId = z.string().regex(/^[1-9][0-9]*$/);
const shipmentDispatchedPayload = z.object({
  schema_version: z.literal(1),
  receipt_id: uuid,
  relation_id: uuid,
  buyer_sales_order_id: nativeId,
  buyer_purchase_order_id: uuid,
  seller_delivery_id: z.string().trim().min(1).max(200),
  seller_delivery_number: z.string().trim().min(1).max(200),
  dispatched_at: z.string().datetime({ offset: true }),
  document: z.object({
    id: z.string().trim().min(1).max(200),
    kind: z.literal("AUTHORITATIVE_SNAPSHOT"),
    snapshot_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  lines: z.array(z.object({
    buyer_sales_order_line_id: nativeId,
    buyer_purchase_order_line_id: uuid,
    seller_delivery_line_id: z.string().trim().min(1).max(200),
    quantity,
    unit: z.string().trim().min(1).max(32),
  }).strict()).min(1).max(10_000),
}).strict();

type ShipmentDispatchedPayload = z.infer<typeof shipmentDispatchedPayload>;

function assertMessageEnvelope(message: IntercompanyMessage): void {
  if (message.kind !== "SHIPMENT_DISPATCHED") {
    throw new HttpError(409, "INTERCOMPANY_FULFILMENT_KIND_UNSUPPORTED", "Ce message ne porte pas une preuve d'expédition.");
  }
  if (!uuid.safeParse(message.id).success || !uuid.safeParse(message.source_company_id).success || !uuid.safeParse(message.destination_company_id).success) {
    throw new HttpError(400, "INTERCOMPANY_FULFILMENT_MESSAGE_INVALID", "L'enveloppe inter-entreprises est invalide.");
  }
  if (message.source_company_id === message.destination_company_id || !Number.isSafeInteger(message.revision) || message.revision <= 0) {
    throw new HttpError(400, "INTERCOMPANY_FULFILMENT_MESSAGE_INVALID", "L'enveloppe inter-entreprises est incohérente.");
  }
}

function assertNoDuplicateLineIdentity(payload: ShipmentDispatchedPayload): void {
  const seen = new Set<string>();
  for (const line of payload.lines) {
    const key = `${line.buyer_sales_order_line_id}:${line.seller_delivery_line_id}`;
    if (seen.has(key)) {
      throw new HttpError(400, "INTERCOMPANY_FULFILMENT_LINES_DUPLICATE", "Une ligne de preuve est présente plusieurs fois.");
    }
    seen.add(key);
  }
}

async function assertDropshipOrderLines(
  tx: Queryable,
  message: IntercompanyMessage,
  payload: ShipmentDispatchedPayload,
): Promise<void> {
  const order = await tx.query<{ id: string; fulfilment_mode: string | null }>(
    `SELECT command.id::text AS id, command.fulfilment_mode
     FROM public.intercompany_purchase_order_links purchase_link
     JOIN public.intercompany_supplier_relations relation ON relation.id = purchase_link.relation_id
     JOIN public.commande_client command ON command.id = purchase_link.buyer_sales_order_id
     WHERE purchase_link.buyer_sales_order_id = $1::bigint
       AND purchase_link.buyer_purchase_order_id = $2::uuid
       AND purchase_link.relation_id = $3::uuid
       AND relation.buyer_company_id = $4::uuid
       AND relation.supplier_company_id = $5::uuid
       AND relation.environment = $6
     FOR UPDATE OF command`,
    [payload.buyer_sales_order_id, payload.buyer_purchase_order_id, payload.relation_id, message.destination_company_id, message.source_company_id, message.environment],
  );
  const header = order.rows[0] ?? null;
  if (!header) throw new HttpError(404, "INTERCOMPANY_FULFILMENT_ORDER_NOT_FOUND", "La commande acheteur est introuvable.");
  if (header.fulfilment_mode !== "SUPPLIER_DROPSHIP") {
    throw new HttpError(409, "INTERCOMPANY_FULFILMENT_MODE_INVALID", "Cette commande n'est pas éligible à une preuve fournisseur externe.");
  }

  const ids = payload.lines.map((line) => line.buyer_sales_order_line_id);
  const result = await tx.query<{ id: string; buyer_purchase_order_line_id: string; quantity: string }>(
    `SELECT command_line.id::text AS id,
            line_link.buyer_purchase_order_line_id::text AS buyer_purchase_order_line_id,
            command_line.quantite::text AS quantity
     FROM public.intercompany_purchase_order_line_links line_link
     JOIN public.commande_ligne command_line ON command_line.id = line_link.buyer_sales_order_line_id
     JOIN public.commande_fournisseur_ligne purchase_line ON purchase_line.id = line_link.buyer_purchase_order_line_id
     WHERE command_line.commande_id = $1::bigint
       AND command_line.id = ANY($2::bigint[])
       AND line_link.buyer_purchase_order_line_id = ANY($3::uuid[])
     FOR UPDATE OF command_line`,
    [payload.buyer_sales_order_id, ids, payload.lines.map((line) => line.buyer_purchase_order_line_id)],
  );
  const linkedPairs = new Set(result.rows.map((row) => `${row.id}:${row.buyer_purchase_order_line_id}`));
  if (
    result.rows.length !== ids.length ||
    payload.lines.some((line) => !linkedPairs.has(`${line.buyer_sales_order_line_id}:${line.buyer_purchase_order_line_id}`))
  ) {
    throw new HttpError(409, "INTERCOMPANY_FULFILMENT_LINE_SCOPE_INVALID", "Une ligne de preuve n'appartient pas à cette commande.");
  }
  const received = new Map<string, number>();
  for (const line of payload.lines) received.set(line.buyer_sales_order_line_id, (received.get(line.buyer_sales_order_line_id) ?? 0) + line.quantity);
  for (const row of result.rows) {
    if ((received.get(row.id) ?? 0) > Number(row.quantity) + 1e-9) {
      throw new HttpError(409, "INTERCOMPANY_FULFILMENT_QUANTITY_INVALID", "La preuve dépasse la quantité commandée.");
    }
  }
}

/**
 * Persists an authenticated seller shipment as buyer-side business evidence.
 * The transport inbox is not itself delivery evidence: this function validates
 * the local dropship order/lines and writes an idempotent, immutable receipt.
 */
export async function applyIntercompanyFulfilmentMessageTx(
  tx: Queryable,
  message: IntercompanyMessage,
): Promise<{ applied: boolean; receipt_id: string }> {
  assertMessageEnvelope(message);
  const parsed = shipmentDispatchedPayload.safeParse(message.payload);
  if (!parsed.success) {
    throw new HttpError(400, "INTERCOMPANY_FULFILMENT_PAYLOAD_INVALID", "La preuve d'expédition inter-entreprises est invalide.");
  }
  const payload = parsed.data;
  assertNoDuplicateLineIdentity(payload);
  await assertDropshipOrderLines(tx, message, payload);

  const inserted = await tx.query<{ message_id: string }>(
    `INSERT INTO public.cerp_intercompany_external_fulfilment_receipts (
       message_id, receipt_id, source_company_id, destination_company_id,
       environment, relation_id, buyer_sales_order_id, buyer_purchase_order_id, seller_delivery_id,
       seller_delivery_number, dispatched_at, document_id, document_kind, document_snapshot_sha256, raw_payload
     ) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6::uuid,$7::bigint,$8::uuid,$9,$10,$11::timestamptz,$12,$13,$14,$15::jsonb)
     ON CONFLICT (message_id) DO NOTHING
     RETURNING message_id::text AS message_id`,
    [
      message.id, payload.receipt_id, message.source_company_id, message.destination_company_id,
      message.environment, payload.relation_id, payload.buyer_sales_order_id, payload.buyer_purchase_order_id,
      payload.seller_delivery_id, payload.seller_delivery_number, payload.dispatched_at,
      payload.document.id, payload.document.kind, payload.document.snapshot_sha256, JSON.stringify(payload),
    ],
  );
  if (!inserted.rows[0]) {
    const existing = await tx.query<{ receipt_id: string }>(
      `SELECT receipt_id::text AS receipt_id
       FROM public.cerp_intercompany_external_fulfilment_receipts
       WHERE message_id = $1::uuid`,
      [message.id],
    );
    const receiptId = existing.rows[0]?.receipt_id;
    if (!receiptId) throw new Error("Intercompany fulfilment receipt replay was not readable");
    return { applied: false, receipt_id: receiptId };
  }

  for (const [index, line] of payload.lines.entries()) {
    await tx.query(
      `INSERT INTO public.cerp_intercompany_external_fulfilment_receipt_lines (
         message_id, line_no, buyer_sales_order_line_id, buyer_purchase_order_line_id, seller_delivery_line_id, quantity, unit
       ) VALUES ($1::uuid,$2,$3::bigint,$4::uuid,$5,$6,$7)`,
      [message.id, index + 1, line.buyer_sales_order_line_id, line.buyer_purchase_order_line_id, line.seller_delivery_line_id, line.quantity, line.unit],
    );
  }

  // A dropship order never receives local stock/OF evidence.  Advance it only
  // once every EC order line is covered by authenticated supplier receipts;
  // partial shipments deliberately leave ATTENTE_FOURNISSEUR untouched.
  const fulfilment = await loadCommandeFulfillmentState(tx, Number(payload.buyer_sales_order_id));
  if (fulfilment.fully_shipped) {
    await repoEnsureCommandeWorkflowStatus({
      tx,
      commande_id: Number(payload.buyer_sales_order_id),
      nouveau_statut: "LIVRE",
      cause: "supplier_shipment_sync",
      commentaire: "Statut synchronisé automatiquement après preuve complète d'expédition fournisseur",
      user_id: null,
    });
  }
  return { applied: true, receipt_id: payload.receipt_id };
}
