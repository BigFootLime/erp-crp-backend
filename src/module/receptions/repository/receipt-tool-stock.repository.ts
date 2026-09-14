import type { PoolClient } from "pg";
import { HttpError } from "../../../utils/httpError";
import { outilRepository } from "../../outils/repository/outil.repository";
import { assertReceiptLotQualityEligibility } from "../../qualite/repository/quality-operational-gate.repository";
import { consumableCommand } from "../../production/repository/consumable-command.repository";
import type { AuditContext } from "./receptions.repository";
import {
  processingEvent,
  readProcessingLine,
} from "./receipt-processing.repository";

export async function postToolReceiptTx(
  tx: PoolClient,
  receptionId: string,
  lineId: string,
  quantity: number,
  audit: AuditContext,
) {
  const line = (
    await tx.query<{
      tool_id: number;
      received: number;
      coefficient: number;
      unit: string;
      lot_id: string | null;
      quality: boolean;
      status: string;
    }>(
      `SELECT l.receipt_tool_id AS tool_id,l.qty_received::float8 AS received,COALESCE(l.stock_conversion_coef,1)::float8 AS coefficient,l.stock_unit AS unit,l.lot_id::text,l.receipt_quality_required AS quality,r.status
    FROM public.reception_fournisseur_lignes l JOIN public.receptions_fournisseurs r ON r.id=l.reception_id
    WHERE l.id=$1::uuid AND r.id=$2::uuid FOR UPDATE OF l,r`,
      [lineId, receptionId],
    )
  ).rows[0];
  if (!line?.tool_id || line.status !== "OPEN")
    throw new HttpError(
      409,
      "TOOL_RECEIPT_NOT_OPEN",
      "Cette ligne n’est pas une réception outillage ouverte.",
    );
  const stocked = Number(
    (
      await tx.query(
        `SELECT COALESCE(sum(quantity),0) AS qty FROM public.reception_tool_stock_receipts WHERE receipt_line_id=$1::uuid`,
        [lineId],
      )
    ).rows[0].qty,
  );
  const converted = quantity * line.coefficient;
  if (
    !Number.isFinite(quantity) ||
    quantity <= 0 ||
    quantity + stocked > line.received + 0.000001 ||
    !Number.isInteger(converted) ||
    converted <= 0
  )
    throw new HttpError(
      422,
      "TOOL_RECEIPT_QUANTITY_INVALID",
      "La quantité doit respecter le reçu et donner un nombre entier d’outils.",
    );
  if (line.quality) {
    if (!line.lot_id)
      throw new HttpError(
        409,
        "QUALITY_RECEIPT_CONTROL_REQUIRED",
        "Identifiez le lot et réalisez son contrôle.",
      );
    await assertReceiptLotQualityEligibility({
      client: tx,
      lotId: line.lot_id,
      receiptLineId: lineId,
      qty: (quantity + stocked) * line.coefficient,
      unit: line.unit,
    });
  }
  await tx.query(
    "SELECT id_outil FROM public.gestion_outils_outil WHERE id_outil=$1 FOR UPDATE",
    [line.tool_id],
  );
  await outilRepository.addToStock(tx, line.tool_id, converted);
  const movement = await outilRepository.logMouvementStock(tx, {
    id_outil: line.tool_id,
    quantite: converted,
    type: "entrée",
    utilisateur: String(audit.user_id),
    user_id: audit.user_id,
    reason: "RECEPTION_FOURNISSEUR",
    source: "reception",
    note: `Réception ${receptionId} · ligne ${lineId}`,
  });
  await tx.query(
    `INSERT INTO public.reception_tool_stock_receipts(receipt_line_id,tool_id,tool_movement_id,quantity,stock_quantity,created_by) VALUES($1::uuid,$2,$3,$4,$5,$6)`,
    [
      lineId,
      line.tool_id,
      Number(movement.id),
      quantity,
      converted,
      audit.user_id,
    ],
  );
  await processingEvent(tx, lineId, audit, "TOOL_STOCKED", {
    movementId: movement.id,
    quantity,
    toolId: line.tool_id,
  });
  return { toolMovementId: movement.id, quantity };
}
export async function stockToolReceipt(
  receptionId: string,
  lineId: string,
  body: { idempotencyKey: string; expectedVersion: number; quantity: number },
  audit: AuditContext,
) {
  const payload = { ...body, receptionId, lineId };
  return consumableCommand(
    {},
    "TOOL_RECEIPT_STOCK",
    payload,
    audit,
    async (tx) => {
      const line = await readProcessingLine(tx, lineId, receptionId, true);
      if (line.version !== body.expectedVersion)
        throw new HttpError(
          409,
          "RECEIPT_PROCESSING_CHANGED",
          "Relisez la réception avant de confirmer.",
        );
      await postToolReceiptTx(tx, receptionId, lineId, body.quantity, audit);
      return readProcessingLine(tx, lineId, receptionId);
    },
  );
}
