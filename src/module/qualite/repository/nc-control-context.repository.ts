import type { PoolClient } from "pg";
import { HttpError } from "../../../utils/httpError";
import type { CreateNonConformityBodyDTO } from "../validators/qualite.validators";

type ControlContext = {
  affaire_id: number | null;
  of_id: number | null;
  piece_technique_id: string | null;
  of_operation_id: string | null;
  lot_id: string | null;
  bon_livraison_id: string | null;
  reception_ligne_id: string | null;
  fournisseur_id: string | null;
  source_type: string | null;
  source_id: string | null;
};

function inherit<T extends string | number>(field: string, supplied: T | null | undefined, known: T | null): T | null {
  const same = typeof supplied === "string" && typeof known === "string"
    ? supplied.toLowerCase() === known.toLowerCase() : supplied === known;
  if (supplied != null && known != null && !same) {
    throw new HttpError(400, "NC_CONTROL_CONTEXT_MISMATCH", "Le contexte de la non-conformité ne correspond pas au contrôle sélectionné.", { field });
  }
  return known ?? supplied ?? null;
}

/** Resolve existing control provenance before the delivery/lot quality locks.
 * No write, automatic release, or inference from unrelated commercial records.
 */
export async function resolveNcControlContext(
  tx: Pick<PoolClient, "query">,
  body: CreateNonConformityBodyDTO
): Promise<CreateNonConformityBodyDTO> {
  if (!body.control_id) return body;
  const result = await tx.query<ControlContext>(`
    SELECT affaire_id::float8, of_id::float8, piece_technique_id::text,
      operation_id::text AS of_operation_id, lot_id::text, bon_livraison_id::text,
      reception_ligne_id::text, fournisseur_id::text, source_type, source_id
    FROM public.quality_control WHERE id = $1::uuid
  `, [body.control_id]);
  const source = result.rows[0];
  if (!source) throw new HttpError(400, "INVALID_CONTROL", "Le contrôle qualité sélectionné n’existe plus.");
  let lot = source.lot_id;
  if (source.source_type === "LOT") {
    const sourceLot = source.source_id?.trim();
    if (!sourceLot || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sourceLot)) {
      throw new HttpError(400, "NC_CONTROL_CONTEXT_INVALID", "Le lot source du contrôle doit être vérifié.");
    }
    lot = inherit("lot_id", lot, sourceLot);
  }
  return {
    ...body,
    affaire_id: inherit("affaire_id", body.affaire_id, source.affaire_id),
    of_id: inherit("of_id", body.of_id, source.of_id),
    piece_technique_id: inherit("piece_technique_id", body.piece_technique_id, source.piece_technique_id),
    of_operation_id: inherit("of_operation_id", body.of_operation_id, source.of_operation_id),
    lot_id: inherit("lot_id", body.lot_id, lot),
    bon_livraison_id: inherit("bon_livraison_id", body.bon_livraison_id, source.bon_livraison_id),
    reception_ligne_id: inherit("reception_ligne_id", body.reception_ligne_id, source.reception_ligne_id),
    fournisseur_id: inherit("fournisseur_id", body.fournisseur_id, source.fournisseur_id),
  };
}
