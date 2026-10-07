import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import {
  assertGedParentLinkWritable,
  assertGedVersionParentReadable,
} from "../../ged/services/ged-parent-authorization.service";
import { supplierReviewCommand } from "../domain/supplier-periodic-review";
import { repoSupplierReviewCommand } from "../repository/supplier-periodic-review.repository";
import {
  repoSupplierReviewBoard,
  repoReviewDueBoard,
  repoReviewEvidenceChoices,
  repoReviewOwners,
} from "../repository/supplier-periodic-review-read.repository";
async function requireSupplier(supplierId: string) {
  if (
    !(
      await pool.query("SELECT id FROM public.fournisseurs WHERE id=$1::uuid", [
        supplierId,
      ])
    ).rows.length
  )
    throw new HttpError(
      404,
      "FOURNISSEUR_NOT_FOUND",
      "Fournisseur introuvable.",
    );
}
export async function supplierReviewBoard(supplierId: string) {
  await requireSupplier(supplierId);
  return repoSupplierReviewBoard(supplierId);
}
export const supplierReviewsDue = repoReviewDueBoard;
export async function supplierReviewOptions(supplierId: string, actor: number) {
  await requireSupplier(supplierId);
  const candidates = await repoReviewEvidenceChoices(supplierId);
  const evidence = [];
  for (const candidate of candidates) {
    try {
      await assertGedVersionParentReadable(actor, candidate.document_id);
      evidence.push(candidate);
    } catch (error) {
      if (!(error instanceof HttpError && [403, 404].includes(error.status)))
        throw error;
    }
  }
  return { evidence, owners: await repoReviewOwners() };
}
export async function supplierReviewWrite(
  supplierId: string,
  body: unknown,
  actor: number,
) {
  const parsed = supplierReviewCommand.safeParse(body);
  if (!parsed.success)
    throw new HttpError(
      422,
      "SUPPLIER_REVIEW_INPUT_INVALID",
      "Corrigez les champs de l’évaluation.",
      { issues: parsed.error.issues },
    );
  await assertGedParentLinkWritable(actor, {
    entity_type: "FOURNISSEUR",
    entity_id: supplierId,
  });
  return repoSupplierReviewCommand(supplierId, parsed.data, actor);
}
