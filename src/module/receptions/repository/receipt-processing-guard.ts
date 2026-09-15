import type { PoolClient } from "pg";
import {receiptTransferInstalled} from '../../subcontract/subcontract-receipt-allocation.repository';
import { HttpError } from "../../../utils/httpError";

/** Shared entry boundary, including manually created and compensating movements. */
export async function assertPieceReceiptMovement(
  tx: Pick<PoolClient, "query">,
  movementId: string,
  movementType: string,
  lines: Array<{ lot_id?: string | null; article_id: string; qty: number }>,
) {
  if (!["IN", "ADJUSTMENT"].includes(movementType)) return;
  for (const line of lines) {
    if (
      Number(line.qty) > 0 &&
      (
        await tx.query(
          "SELECT 1 FROM public.article_tool_links WHERE article_id=$1::uuid",
          [line.article_id],
        )
      ).rows.length
    )
      throw new HttpError(
        409,
        "TOOL_ARTICLE_STOCK_FORBIDDEN",
        "Cette référence alimente uniquement le registre de stock outillage.",
      );
    if (!line.lot_id || Number(line.qty) <= 0) continue;
    const source = (
      await tx.query(
        `SELECT id FROM public.reception_fournisseur_lignes WHERE lot_id=$1::uuid AND processing_policy='PIECES_CONTROLE_EMBALLAGE' FOR UPDATE`,
        [line.lot_id],
      )
    ).rows[0];
    if (source)
      throw new HttpError(
        409,
        "RECEIPT_PACKAGING_REQUIRED",
        "Cette pièce doit passer par contrôle, emballage et validation d’entrée en stock MP.",
      );
    const portion = (
      await tx.query<{
        movement_id: string;
        article_id: string;
        quantity: number;
        category: string;
        voided_at: string | null;
        reconcile: boolean;
      }>(
        `SELECT p.stock_movement_id::text AS movement_id,r.stock_article_id::text AS article_id,p.stock_quantity::float8 AS quantity,a.article_category AS category,k.voided_at,r.processing_reconciliation_required AS reconcile
      FROM public.reception_stock_portions p JOIN public.reception_fournisseur_lignes r ON r.id=p.receipt_line_id
      JOIN public.reception_packaging k ON k.id=p.packaging_id JOIN public.articles a ON a.id=r.stock_article_id
      WHERE p.stock_lot_id=$1::uuid FOR UPDATE OF r,k`,
        [line.lot_id],
      )
    ).rows[0];
    if (
      portion &&
      (portion.movement_id !== movementId ||
        portion.article_id !== line.article_id ||
        Math.abs(portion.quantity - Number(line.qty)) > 0.000001 ||
        portion.category !== "matiere" ||
        portion.voided_at ||
        portion.reconcile)
    )
      throw new HttpError(
        409,
        "RECEIPT_STOCK_PORTION_INVALID",
        "L’entrée doit correspondre exactement à sa portion emballée et à sa référence MP.",
      );
  }
}

export async function assertReceiptProcessingClosed(
  tx: Pick<PoolClient, "query">,
  where: { receptionId?: string; orderId?: string; orderLineId?: string },
) {
  const transferredSql=await receiptTransferInstalled(tx)?'public.subcontract_receipt_transferred_968(l.id)':'0';
  const pending = (
    await tx.query(
      `SELECT l.id FROM public.reception_fournisseur_lignes l
    LEFT JOIN public.commande_fournisseur_ligne cl ON cl.id=l.commande_fournisseur_ligne_id
    LEFT JOIN public.receipt_processing_dispositions_1069 d ON d.receipt_line_id=l.id
    WHERE ($1::uuid IS NULL OR l.reception_id=$1::uuid) AND ($2::uuid IS NULL OR cl.commande_id=$2::uuid)
      AND ($3::uuid IS NULL OR cl.id=$3::uuid)
      AND l.processing_policy='PIECES_CONTROLE_EMBALLAGE' AND (l.processing_reconciliation_required OR COALESCE(d.open_nc,0)>0 OR l.qty_received > COALESCE(d.disposed,0)+${transferredSql}+COALESCE((
        SELECT sum(s.qty) FROM public.reception_fournisseur_stock_receipts s JOIN public.stock_movements m ON m.id=s.stock_movement_id WHERE s.reception_line_id=l.id AND m.status='POSTED'),0)) LIMIT 1`,
      [
        where.receptionId ?? null,
        where.orderId ?? null,
        where.orderLineId ?? null,
      ],
    )
  ).rows[0];
  if (pending)
    throw new HttpError(
      409,
      "RECEIPT_PROCESSING_OPEN",
      "Des pièces attendent encore un contrôle, un emballage, une entrée en stock ou le traitement d’un écart.",
    );
}
