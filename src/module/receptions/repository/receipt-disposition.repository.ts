import type { PoolClient } from "pg";
import { HttpError } from "../../../utils/httpError";
import { processingEvent } from "./receipt-processing.repository";
import type { AuditContext } from "./receptions.repository";

/** Rejected received pieces have no stock to remove. Keep the authoritative NC
 * disposition, bound to its physical receipt, without inventing an IN then OUT. */
export async function recordPreStockReceiptDisposition(
  tx: PoolClient,
  args: {
    ncId: string;
    dispositionId: string;
    lotId: string | null;
    quantity: number | null;
    unit: string | null;
    type: string;
    audit: AuditContext;
  },
) {
  if (!args.lotId || !["SCRAP", "RETURN_SUPPLIER"].includes(args.type))
    return false;
  const line = (
    await tx.query<{
      id: string;
      qty: number;
      unit: string;
      reconcile: boolean;
    }>(
      `SELECT r.id::text,(r.qty_received*COALESCE(r.stock_conversion_coef,1))::float8 AS qty,r.stock_unit AS unit,r.processing_reconciliation_required AS reconcile
    FROM public.reception_fournisseur_lignes r JOIN public.non_conformity nc ON nc.id=$2::uuid
    WHERE r.lot_id=$1::uuid AND r.processing_policy='PIECES_CONTROLE_EMBALLAGE'
      AND (nc.reception_ligne_id=r.id OR nc.control_id IN(SELECT id FROM public.quality_control WHERE reception_ligne_id=r.id))
      AND NOT EXISTS(SELECT 1 FROM public.stock_movement_lines ml JOIN public.stock_movements m ON m.id=ml.movement_id WHERE ml.lot_id=r.lot_id AND m.status='POSTED')
    FOR UPDATE OF r`,
      [args.lotId, args.ncId],
    )
  ).rows[0];
  if (!line) return false;
  if (line.reconcile)
    throw new HttpError(
      409,
      "RECEIPT_RECONCILIATION_REQUIRED",
      "Justifiez la reprise avant de traiter cet écart de réception.",
    );
  await tx.query("SELECT id FROM public.lots WHERE id=$1::uuid FOR UPDATE", [
    args.lotId,
  ]);
  const totals = (
    await tx.query<{ accepted: number; disposed: number }>(
      `SELECT COALESCE((SELECT qty_released FROM public.quality_control WHERE reception_ligne_id=$1::uuid ORDER BY control_date DESC,id DESC LIMIT 1),0)::float8 AS accepted,
    COALESCE((SELECT sum(d.qty) FROM public.non_conformity_dispositions d JOIN public.non_conformity nc ON nc.id=d.non_conformity_id
      WHERE (nc.reception_ligne_id=$1::uuid OR nc.control_id IN(SELECT id FROM public.quality_control WHERE reception_ligne_id=$1::uuid))
        AND nc.status::text<>'CANCELLED' AND d.id<>$2::uuid AND d.disposition_type IN('SCRAP','RETURN_SUPPLIER') AND d.stock_movement_id IS NULL),0)::float8 AS disposed`,
      [line.id, args.dispositionId],
    )
  ).rows[0];
  if (
    !args.quantity ||
    !Number.isFinite(args.quantity) ||
    args.quantity <= 0 ||
    args.unit?.trim().toUpperCase() !== line.unit?.trim().toUpperCase() ||
    args.quantity + totals.disposed + totals.accepted > line.qty + 0.000001
  )
    throw new HttpError(
      422,
      "RECEIPT_DISPOSITION_QUANTITY",
      "La disposition doit porter sur une quantité non acceptée, non déjà traitée, dans l’unité de stock de la réception.",
    );
  await processingEvent(tx, line.id, args.audit, "PRE_STOCK_DISPOSITION", {
    nonConformityId: args.ncId,
    dispositionId: args.dispositionId,
    type: args.type,
    quantity: args.quantity,
    unit: args.unit,
  });
  return true;
}
