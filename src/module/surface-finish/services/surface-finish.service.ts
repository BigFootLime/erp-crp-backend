// #210 — Services de la bibliothèque de finitions. La couche service applique
// les règles qui dépendent de l'ACTEUR (capacités fines, override d'un texte
// généré) et délègue la persistance au repository.

import { HttpError } from "../../../utils/httpError";
import type { AuditContext } from "../../pieces-techniques/repository/pieces-techniques.repository";
import {
  assertSurfaceFinishCapability,
  normalizeIdempotencyKey,
  surfaceFinishCapabilitiesFor,
  type SurfaceFinishCapability,
} from "../domain/surface-finish-policy";
import {
  repoAttachRevisionDocument,
  repoCreateFinishDraft,
  repoCreateRevision,
  repoGetFinish,
  repoListFinishes,
  repoListFinishFamilies,
  repoListRevisionDocuments,
  repoRevisionImpact,
  repoTransitionRevision,
  repoUpdateFinishDraft,
  repoUpdateRevision,
  type RevisionImpact,
} from "../repository/surface-finish-library.repository";
import {
  repoArchiveFinish,
  repoFindSimilarFinishes,
  repoListFinishHistory,
  repoReactivateFinish,
  repoSetFinishFavorite,
} from "../repository/surface-finish-admin.repository";
import {
  repoConfirmOperationFinish,
  repoDetachOperationFinish,
  repoGetOperationFinish,
  repoPreviewOperationFinish,
} from "../repository/surface-finish-resolution.repository";
import type {
  ArchiveFinishBodyDTO,
  AttachDocumentBodyDTO,
  ConfirmFinishBodyDTO,
  CreateFinishBodyDTO,
  DetachFinishBodyDTO,
  FinishHistoryQueryDTO,
  ListFinishesQueryDTO,
  PreviewFinishBodyDTO,
  ReactivateFinishBodyDTO,
  RevisionPayloadDTO,
  SimilarFinishesQueryDTO,
  TransitionRevisionBodyDTO,
  UpdateFinishBodyDTO,
  UpdateRevisionBodyDTO,
} from "../validators/surface-finish.validators";
import type {
  ConfirmFinishResult,
  OperationFinishRequirement,
  SurfaceFinishDetail,
  SurfaceFinishDocument,
  SurfaceFinishFamily,
  SurfaceFinishHistoryEntry,
  SurfaceFinishListResult,
  SurfaceFinishPreview,
  SurfaceFinishRevisionDetail,
  SurfaceFinishSimilarMatch,
} from "../types/surface-finish.types";

export type Actor = { user_id: number; role: string | null };

export async function listFinishFamiliesSVC(): Promise<SurfaceFinishFamily[]> {
  return repoListFinishFamilies();
}

export async function listFinishesSVC(
  filters: ListFinishesQueryDTO,
  viewerUserId: number
): Promise<SurfaceFinishListResult> {
  return repoListFinishes(filters, viewerUserId);
}

export async function getFinishSVC(finishId: string, viewerUserId: number): Promise<SurfaceFinishDetail> {
  const finish = await repoGetFinish(finishId, viewerUserId);
  if (!finish) throw new HttpError(404, "NOT_FOUND", "Finition introuvable.");
  return finish;
}

/* -------------------------------------------------------------------------- */
/* #226 — Doublons, favoris, archivage, historique                            */
/* -------------------------------------------------------------------------- */

export async function findSimilarFinishesSVC(query: SimilarFinishesQueryDTO): Promise<SurfaceFinishSimilarMatch[]> {
  return repoFindSimilarFinishes(query);
}

/** Un favori est personnel : l'identité vient du jeton, jamais du corps. */
export async function setFinishFavoriteSVC(
  finishId: string,
  actor: Actor,
  favorite: boolean
): Promise<{ finish_id: string; favori: boolean }> {
  return repoSetFinishFavorite(finishId, actor.user_id, favorite);
}

/**
 * Archiver et réactiver exigent `library_retire` — une capacité déclarée depuis
 * #210 mais que rien n'avait encore imposée, faute de chemin d'archivage.
 */
export async function archiveFinishSVC(
  finishId: string,
  body: ArchiveFinishBodyDTO,
  actor: Actor,
  audit: AuditContext
): Promise<SurfaceFinishDetail> {
  assertSurfaceFinishCapability(actor.role, "library_retire");
  return repoArchiveFinish(finishId, body, audit);
}

export async function reactivateFinishSVC(
  finishId: string,
  body: ReactivateFinishBodyDTO,
  actor: Actor,
  audit: AuditContext
): Promise<SurfaceFinishDetail> {
  assertSurfaceFinishCapability(actor.role, "library_retire");
  return repoReactivateFinish(finishId, body, audit);
}

export async function listFinishHistorySVC(
  finishId: string,
  query: FinishHistoryQueryDTO,
  actor: Actor
): Promise<SurfaceFinishHistoryEntry[]> {
  assertSurfaceFinishCapability(actor.role, "audit_read");
  return repoListFinishHistory(finishId, query);
}

export async function createFinishDraftSVC(body: CreateFinishBodyDTO, audit: AuditContext): Promise<SurfaceFinishDetail> {
  return repoCreateFinishDraft(body, audit);
}

export async function updateFinishDraftSVC(
  finishId: string,
  body: UpdateFinishBodyDTO,
  audit: AuditContext
): Promise<SurfaceFinishDetail> {
  return repoUpdateFinishDraft(finishId, body, audit);
}

export async function createRevisionSVC(
  finishId: string,
  body: RevisionPayloadDTO,
  audit: AuditContext
): Promise<SurfaceFinishRevisionDetail> {
  return repoCreateRevision(finishId, body, audit);
}

export async function updateRevisionSVC(
  revisionId: string,
  body: UpdateRevisionBodyDTO,
  audit: AuditContext
): Promise<SurfaceFinishRevisionDetail> {
  return repoUpdateRevision(revisionId, body, audit);
}

/**
 * Transition de statut. Publier ou retirer exige des capacités DIFFÉRENTES :
 * approuver engage la conformité produit, retirer engage l'atelier.
 */
export async function transitionRevisionSVC(
  revisionId: string,
  body: TransitionRevisionBodyDTO,
  audit: AuditContext,
  actor: Actor
): Promise<SurfaceFinishRevisionDetail> {
  const required: SurfaceFinishCapability =
    body.statut === "ACTIVE"
      ? "library_approve"
      : body.statut === "EN_VALIDATION"
        ? "library_submit"
        : "library_retire";
  assertSurfaceFinishCapability(actor.role, required);

  // Retirer une révision utilisée n'est jamais un geste anodin : on exige un motif.
  if (body.statut === "SUSPENDUE" || body.statut === "OBSOLETE" || body.statut === "ARCHIVEE") {
    const impact = await repoRevisionImpact(revisionId);
    if (impact.gammes > 0 && (body.motif ?? "").trim().length < 10) {
      throw new HttpError(
        422,
        "SURFACE_FINISH_RETIRE_REASON_REQUIRED",
        `Cette révision est utilisée par ${impact.gammes} gamme(s) : un motif d'au moins 10 caractères est requis.`,
        { impact }
      );
    }
  }

  return repoTransitionRevision(revisionId, body, audit);
}

export async function revisionImpactSVC(revisionId: string): Promise<RevisionImpact> {
  return repoRevisionImpact(revisionId);
}

export async function listRevisionDocumentsSVC(revisionId: string): Promise<SurfaceFinishDocument[]> {
  return repoListRevisionDocuments(revisionId);
}

export async function attachRevisionDocumentSVC(
  revisionId: string,
  body: AttachDocumentBodyDTO,
  audit: AuditContext
): Promise<SurfaceFinishDocument> {
  return repoAttachRevisionDocument(revisionId, body, audit);
}

/* -------------------------------------------------------------------------- */
/* Configuration d'opération                                                   */
/* -------------------------------------------------------------------------- */

export async function getOperationFinishSVC(
  gammeId: string,
  operationId: string
): Promise<OperationFinishRequirement | null> {
  return repoGetOperationFinish(gammeId, operationId);
}

export async function previewOperationFinishSVC(
  gammeId: string,
  operationId: string,
  body: PreviewFinishBodyDTO,
  actor: Actor
): Promise<SurfaceFinishPreview> {
  return repoPreviewOperationFinish(gammeId, operationId, body, actor);
}

export async function confirmOperationFinishSVC(
  gammeId: string,
  operationId: string,
  body: ConfirmFinishBodyDTO,
  audit: AuditContext,
  actor: Actor,
  rawIdempotencyKey: string | null | undefined
): Promise<ConfirmFinishResult> {
  const idempotencyKey = normalizeIdempotencyKey(rawIdempotencyKey);
  return repoConfirmOperationFinish(gammeId, operationId, body, audit, actor, idempotencyKey);
}

export async function detachOperationFinishSVC(
  gammeId: string,
  operationId: string,
  body: DetachFinishBodyDTO,
  audit: AuditContext
): Promise<{ detached: true }> {
  return repoDetachOperationFinish(gammeId, operationId, body, audit);
}

export function capabilitiesSVC(actor: Actor) {
  return surfaceFinishCapabilitiesFor(actor.role);
}
