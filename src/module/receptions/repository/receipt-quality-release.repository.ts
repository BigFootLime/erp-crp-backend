import type { PoolClient } from "pg";
import { HttpError } from "../../../utils/httpError";

/** Lock receipt before lot/control, like packing and receipt stock commands. */
export async function lockReceiptReleaseScope(
  tx: PoolClient,
  lineId: string | null,
) {
  if (!lineId) return null;
  const line = (
    await tx.query<{ id: string; quantity: number; unit: string }>(
      `SELECT id::text,(qty_received*COALESCE(stock_conversion_coef,1))::float8 AS quantity,stock_unit AS unit
     FROM public.reception_fournisseur_lignes
     WHERE id=$1::uuid AND processing_policy='PIECES_CONTROLE_EMBALLAGE' FOR UPDATE`,
      [lineId],
    )
  ).rows[0];
  return line ?? null;
}

export async function assertReceiptReleaseAvailable(
  tx: PoolClient,
  line: Awaited<ReturnType<typeof lockReceiptReleaseScope>>,
  released: number,
  unit: string,
) {
  if (!line) return;
  // Pending dispositions already represent a physical return/scrap; closing the
  // NC is required for dossier closure, not for reserving this rejected quantity.
  const disposed = Number(
    (
      await tx.query<{ quantity: number }>(
        `SELECT COALESCE(sum(d.qty),0)::float8 AS quantity
     FROM public.non_conformity_dispositions d JOIN public.non_conformity nc ON nc.id=d.non_conformity_id
     WHERE (nc.reception_ligne_id=$1::uuid OR nc.control_id IN(SELECT id FROM public.quality_control WHERE reception_ligne_id=$1::uuid))
       AND nc.status::text<>'CANCELLED' AND d.disposition_type IN('SCRAP','RETURN_SUPPLIER') AND d.stock_movement_id IS NULL`,
        [line.id],
      )
    ).rows[0].quantity,
  );
  if (
    unit.trim().toUpperCase() !== line.unit?.trim().toUpperCase() ||
    released + disposed > line.quantity + 0.000001
  ) {
    throw new HttpError(
      409,
      "RECEIPT_RELEASE_DISPOSED_QUANTITY",
      "La libération ne peut pas reprendre les quantités déjà retournées ou rebutées.",
    );
  }
}
