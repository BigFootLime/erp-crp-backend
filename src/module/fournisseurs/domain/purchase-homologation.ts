import { HttpError } from "../../../utils/httpError";

export type PurchaseHomologation = {
  id: string; version: number; statut: string; valid_from: string | null; valid_to: string | null; document_id: string | null;
};

/** A configured global decision governs every purchase; absence is not a qualification. */
export function assertGlobalPurchaseHomologation(decision: PurchaseHomologation | null, today: string): void {
  if (!decision) return;
  if (decision.statut !== "homologue" || (decision.valid_from && decision.valid_from > today) || (decision.valid_to && decision.valid_to < today)) {
    throw new HttpError(409, "SUPPLIER_HOMOLOGATION_NOT_VALID",
      "L’homologation globale du fournisseur ne permet pas cet achat à cette date. Faites vérifier son statut et sa validité par la Qualité.",
      { homologation_id: decision.id, version: decision.version, statut: decision.statut, valid_from: decision.valid_from, valid_to: decision.valid_to });
  }
}
