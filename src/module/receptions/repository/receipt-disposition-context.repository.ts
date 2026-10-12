import type { PoolClient } from "pg";
import { HttpError } from "../../../utils/httpError";
import type { ReceiptDispositionContext } from "../types/receipt-disposition.types";

/** Shared with the write path: receiving-buffer pieces have not entered stock. */
export const PRE_STOCK_RECEIPT_PREDICATE = `r.lot_id=$1::uuid AND r.processing_policy='PIECES_CONTROLE_EMBALLAGE'
  AND (nc.reception_ligne_id=r.id OR nc.control_id IN(SELECT id FROM public.quality_control WHERE reception_ligne_id=r.id))
  AND NOT EXISTS(SELECT 1 FROM public.stock_movement_lines ml JOIN public.stock_movements m ON m.id=ml.movement_id WHERE ml.lot_id=r.lot_id AND m.status='POSTED')`;

export async function readReceiptDispositionContext(
  tx: Pick<PoolClient, "query">,
  ncId: string,
  lotId: string | null,
): Promise<ReceiptDispositionContext | null> {
  if (!lotId) return null;
  const result = await tx.query<ReceiptDispositionContext>(
    `SELECT r.id::text AS "receiptLineId",r.stock_unit AS unit,
    r.processing_reconciliation_required AS "reconciliationRequired",
    greatest(0,r.qty_received*COALESCE(r.stock_conversion_coef,1)
      -COALESCE((SELECT qty_released FROM public.quality_control WHERE reception_ligne_id=r.id ORDER BY control_date DESC,id DESC LIMIT 1),0)
      -COALESCE((SELECT sum(d.qty) FROM public.non_conformity_dispositions d JOIN public.non_conformity origin ON origin.id=d.non_conformity_id
        WHERE (origin.reception_ligne_id=r.id OR origin.control_id IN(SELECT id FROM public.quality_control WHERE reception_ligne_id=r.id))
          AND origin.status::text<>'CANCELLED' AND d.disposition_type IN('SCRAP','RETURN_SUPPLIER') AND d.stock_movement_id IS NULL),0))::float8 AS "remainingQty"
    FROM public.reception_fournisseur_lignes r JOIN public.non_conformity nc ON nc.id=$2::uuid
    WHERE ${PRE_STOCK_RECEIPT_PREDICATE} ORDER BY r.id`,
    [lotId, ncId],
  );
  // An ambiguous receipt must not silently choose one physical source.
  if (result.rows.length > 1)
    throw new HttpError(
      409,
      "RECEIPT_DISPOSITION_AMBIGUOUS",
      "La non-conformité est liée à plusieurs lignes de réception. Précisez son origine.",
    );
  return result.rows[0] ?? null;
}
