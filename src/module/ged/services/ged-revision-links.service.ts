import { HttpError } from "../../../utils/httpError";
import { assertGedCapability } from "../domain/ged-policy";
import { repoAddLink, repoLogAccess, withGedTransaction } from "../repository/ged.repository";
import { repoListReusableRevisionDocuments, repoLockPieceRevisions, repoLockRevisionDocument } from "../repository/ged-revision-links.repository";
import { assertGedParentLinkWritable, assertGedVersionParentReadable } from "./ged-parent-authorization.service";
import type { GedActor } from "./ged.service";
import type { ReuseRevisionDocumentBody } from "../validators/ged.validators";

export async function listReusableRevisionDocuments(actor: GedActor, revisionId: string) {
  assertGedCapability(actor.role, "upload");
  await assertGedParentLinkWritable(actor.id, { entity_type: "PIECE_TECHNIQUE_VERSION", entity_id: revisionId });
  return repoListReusableRevisionDocuments(revisionId);
}

export async function reuseRevisionDocument(actor: GedActor, documentId: string, input: ReuseRevisionDocumentBody) {
  assertGedCapability(actor.role, "upload");
  await assertGedVersionParentReadable(actor.id, documentId);
  await assertGedParentLinkWritable(actor.id, { entity_type: "PIECE_TECHNIQUE_VERSION", entity_id: input.revision_id });
  return withGedTransaction(async tx => {
    const state = await repoLockRevisionDocument(tx, documentId);
    if (!state || !state.links.length || state.links.some(link => link.entity_type !== "PIECE_TECHNIQUE_VERSION" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(link.entity_id))) {
      throw new HttpError(404, "GED_VERSION_NOT_FOUND", "Version introuvable.");
    }
    const { document, version } = state;
    if (document.archived_at || version.status === "OBSOLETE" || version.scan_status !== "clean" || version.quarantine_status !== "released") {
      throw new HttpError(409, "GED_REUSE_UNAVAILABLE", "Ce document ne peut pas être réutilisé dans son état actuel.");
    }
    const expectedClass = input.link_role === "PLAN_CLIENT" ? "PLAN_CLIENT" : "GAMME_DOC";
    if (document.class_key !== expectedClass) {
      throw new HttpError(409, "GED_REUSE_CLASS", "La classe du document ne correspond pas au plan attendu.");
    }
    if (version.id !== input.expected_version_id) {
      throw new HttpError(409, "GED_REUSE_STALE", "Le document a changé. Actualisez la sélection avant de le réutiliser.");
    }
    const ids = [...new Set([...state.links.map(link => link.entity_id), input.revision_id])];
    const revisions = await repoLockPieceRevisions(tx, ids);
    if (revisions.length !== ids.length || new Set(revisions.map(row => row.piece_id)).size !== 1) {
      throw new HttpError(404, "GED_VERSION_NOT_FOUND", "Version introuvable.");
    }
    if (revisions.find(row => row.id === input.revision_id)?.statut === "OBSOLETE") {
      throw new HttpError(409, "GED_REUSE_TARGET_OBSOLETE", "La révision cible est obsolète.");
    }
    const created = await repoAddLink(tx, { document_id: documentId, entity_type: "PIECE_TECHNIQUE_VERSION",
      entity_id: input.revision_id, link_role: input.link_role, created_by: actor.id });
    if (created) await repoLogAccess(tx, { document_id: documentId, version_id: version.id,
      event_type: "CHECKIN", actor_id: actor.id, details: { action: "REVISION_LINK_ADDED",
        revision_id: input.revision_id, link_role: input.link_role, reason: input.reason } });
    return { document_id: documentId, version_id: version.id, created };
  });
}
