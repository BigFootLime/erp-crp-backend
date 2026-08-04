// GED centrale CERP (ADR-0037) — orchestration.
//
// Ordre invariant du dépôt : contrôle + empreinte -> transaction + verrou SHA
// -> promotion du blob -> métadonnées -> COMMIT. Une compensation post-rollback
// reprend le même verrou sur une connexion fraîche avant de décider de supprimer
// ou préserver le blob partagé.

import fs from "node:fs/promises";

import type { PoolClient } from "pg";

import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import logger from "../../../utils/logger";
import {
  cleanupUploadsAfterConfirmedRollback,
  cleanupUploadsAfterReconciledNoCommit,
  markUploadCommitAttempted,
  markUploadCommitUncertain,
  markUploadRollbackUncertain,
  markUploadsCommitted,
  UploadDestinationCleanupError,
} from "../../../shared/uploads/secure-upload";
import { assertAcceptedFileOnDisk } from "../domain/ged-content";
import {
  assertDistinctApprover,
  assertGedCapability,
  assertVersionTransition,
  type GedVersionStatus,
} from "../domain/ged-policy";
import {
  repoAddLink,
  repoAddVersion,
  repoCreateDocumentWithVersion,
  repoFindDocumentByBlobHash,
  repoGetGedBlobReferenceState,
  repoGetClass,
  repoGetDocumentDetail,
  repoGetTree,
  repoGetVersionForUpdate,
  repoInsertApproval,
  repoInternalGetVersionContentRef,
  repoIsVersionBlobCommitted,
  repoLockGedBlobSha256,
  repoListAccessEvents,
  repoListClasses,
  repoListDocuments,
  repoLogAccess,
  repoObsoletePreviousApplicable,
  repoSetCurrentVersion,
  repoSetVersionStatus,
  repoUpsertBlob,
  withGedBlobSha256Coordination,
  withGedTransaction,
  GedBlobCleanupUncertainError,
  GedCommitUncertainError,
} from "../repository/ged.repository";
import type {
  GedAccessEvent,
  GedDocumentClass,
  GedDocumentDetail,
  GedListFilters,
  GedListResult,
  GedTreeNode,
} from "../types/ged.types";
import {
  checkVaultHealth,
  computeFileSha256,
  resolveBlobForDownload,
  storageKeyForSha256,
  writeBlobFromPath,
} from "./ged-vault.service";

export type GedActor = { id: number; role: string | null };

type UploadedFile = {
  path?: string;
  originalname?: string;
  mimetype?: string;
  size?: number;
  uploadSecurity?: { sha256: string };
};
type GedUploadTransactionResult = { documentId: string; versionId: string };

async function coordinateGedBlobCleanup(
  sha256: string,
  files: readonly { path: string }[],
  mode: "confirmed-rollback" | "reconciled-no-commit"
): Promise<void> {
  const outcome = await withGedBlobSha256Coordination(sha256, async (tx) => {
    const state = await repoGetGedBlobReferenceState(tx, sha256);
    if (state.blob_present || state.reference_count > 0) return "preserved" as const;
    if (mode === "confirmed-rollback") {
      await cleanupUploadsAfterConfirmedRollback(files);
    } else {
      await cleanupUploadsAfterReconciledNoCommit(files);
    }
    return "cleaned" as const;
  });
  if (outcome === "preserved") markUploadsCommitted(files);
}

function uploadTransactionHooks(
  files: readonly { path: string }[],
  sha256: string,
  promotionCompleted: () => boolean
) {
  return {
    beforeCommit: () => markUploadCommitAttempted(files),
    afterCommit: () => markUploadsCommitted(files),
    afterConfirmedRollback: async () => {
      if (!promotionCompleted()) return;
      try {
        await coordinateGedBlobCleanup(sha256, files, "confirmed-rollback");
      } catch (error) {
        if (error instanceof UploadDestinationCleanupError) throw error;
        logger.error("[GED_BLOB_CLEANUP_UNCERTAIN] rollback compensation could not be coordinated");
        markUploadRollbackUncertain(files);
        throw new GedBlobCleanupUncertainError(error);
      }
    },
    afterRollbackUncertain: () => markUploadRollbackUncertain(files),
  };
}

async function reconcileGedCommit(
  error: GedCommitUncertainError<GedUploadTransactionResult>,
  sha256: string,
  storageKey: string,
  files: readonly { path: string }[]
): Promise<GedUploadTransactionResult> {
  let outcome: Awaited<ReturnType<typeof repoIsVersionBlobCommitted>>;
  let durableFilePresent = false;
  try {
    outcome = await repoIsVersionBlobCommitted(error.transactionResult.versionId, sha256);
    if (outcome === "committed") {
      const blob = await resolveBlobForDownload(storageKey);
      durableFilePresent = await fs.stat(blob.file_path).then((stat) => stat.isFile()).catch(() => false);
    }
  } catch (reconcileError) {
    logger.error("[GED_UPLOAD_COMMIT_UNCERTAIN] fresh-connection reconciliation failed", JSON.stringify({
      version_id: error.transactionResult.versionId,
    }));
    markUploadCommitUncertain(files);
    throw error;
  }
  if (outcome === "committed") {
    if (!durableFilePresent) {
      logger.error("[GED_UPLOAD_COMMIT_UNCERTAIN] metadata committed but durable blob missing", JSON.stringify({
        version_id: error.transactionResult.versionId,
      }));
      markUploadCommitUncertain(files);
      throw error;
    }
    markUploadsCommitted(files);
    return error.transactionResult;
  }
  if (outcome === "not-committed") {
    try {
      await coordinateGedBlobCleanup(sha256, files, "reconciled-no-commit");
    } catch (cleanupError) {
      if (cleanupError instanceof UploadDestinationCleanupError) throw cleanupError;
      logger.error("[GED_UPLOAD_COMMIT_UNCERTAIN] no-commit cleanup could not be coordinated", JSON.stringify({
        version_id: error.transactionResult.versionId,
      }));
      markUploadCommitUncertain(files);
      throw error;
    }
    throw error.originalError;
  }
  logger.error("[GED_UPLOAD_COMMIT_UNCERTAIN] metadata mismatch; durable blob preserved", JSON.stringify({
    version_id: error.transactionResult.versionId,
  }));
  markUploadCommitUncertain(files);
  throw error;
}

/**
 * Relit un document APRÈS le commit.
 *
 * `repoGetDocumentDetail` ouvre sa propre connexion : appelé à l'intérieur d'une
 * transaction encore ouverte, il ne verrait rien de ce qu'elle vient d'écrire.
 * Défaut constaté au premier dépôt réel le 2026-07-28.
 */
async function readDetailOrFail(documentId: string): Promise<GedDocumentDetail> {
  const detail = await repoGetDocumentDetail(documentId);
  if (!detail) {
    throw new HttpError(500, "GED_DOCUMENT_NOT_FOUND", "Document enregistré mais illisible.");
  }
  return detail;
}

/* -------------------------------------------------------------------------- */
/* Lecture                                                                    */
/* -------------------------------------------------------------------------- */

export async function listClasses(actor: GedActor): Promise<GedDocumentClass[]> {
  assertGedCapability(actor.role, "read");
  return repoListClasses();
}

export async function listDocuments(actor: GedActor, filters: GedListFilters): Promise<GedListResult> {
  assertGedCapability(actor.role, "read");
  return repoListDocuments(filters);
}

export async function getDocument(actor: GedActor, documentId: string): Promise<GedDocumentDetail> {
  assertGedCapability(actor.role, "read");
  const detail = await repoGetDocumentDetail(documentId);
  if (!detail) {
    throw new HttpError(404, "GED_DOCUMENT_NOT_FOUND", "Document introuvable.");
  }
  return detail;
}

export async function getTree(actor: GedActor): Promise<GedTreeNode[]> {
  assertGedCapability(actor.role, "read");
  const rows = await repoGetTree();

  // L'arborescence est CALCULÉE à partir du référentiel et des liens. Elle
  // n'existe nulle part sur le disque : renommer une classe ne déplace rien.
  const byDomain = new Map<string, GedTreeNode>();
  for (const row of rows) {
    let domainNode = byDomain.get(row.domain);
    if (!domainNode) {
      domainNode = { key: row.domain, label: row.domain, kind: "DOMAIN", documents_count: 0, children: [] };
      byDomain.set(row.domain, domainNode);
    }
    domainNode.children.push({
      key: row.class_key,
      label: row.class_label,
      kind: "CLASS",
      documents_count: row.documents_count,
      children: [],
    });
    domainNode.documents_count += row.documents_count;
  }
  return [...byDomain.values()];
}

export async function listDocumentHistory(actor: GedActor, documentId: string): Promise<GedAccessEvent[]> {
  assertGedCapability(actor.role, "read");
  return repoListAccessEvents(documentId);
}

export async function getVaultStatus(actor: GedActor) {
  assertGedCapability(actor.role, "read");
  return checkVaultHealth();
}

/* -------------------------------------------------------------------------- */
/* Dépôt                                                                      */
/* -------------------------------------------------------------------------- */

export type UploadDocumentInput = {
  class_key: string;
  title: string;
  description?: string | null;
  change_reason?: string | null;
  link?: { entity_type: string; entity_id: string; link_role?: string | null } | null;
};

export async function uploadDocument(
  actor: GedActor,
  input: UploadDocumentInput,
  file: UploadedFile | undefined
): Promise<GedDocumentDetail> {
  assertGedCapability(actor.role, "upload");

  const documentClass = await repoGetClass(input.class_key);
  if (!documentClass) {
    throw new HttpError(400, "GED_CLASS_UNKNOWN", `Classe documentaire inconnue : ${input.class_key}.`);
  }

  const accepted = await assertAcceptedFileOnDisk(file, {
    class_key: documentClass.class_key,
    allowed_mime_types: documentClass.allowed_mime_types,
    allowed_extensions: documentClass.allowed_extensions,
    max_size_bytes: documentClass.max_size_bytes,
  });

  // `accepted` is validated metadata, but lifecycle ownership must keep the
  // original Multer object so a close-before-registration race is observable.
  // The central security hash is computed before waiting for the database
  // lock; direct service tests fall back to a bounded streaming hash.
  const uploadedFile = file as UploadedFile & { path: string };
  const uploadedFiles = [uploadedFile];
  const expectedSha256 = uploadedFile.uploadSecurity?.sha256
    ?? await computeFileSha256(uploadedFile.path);
  const storageKey = storageKeyForSha256(expectedSha256);
  let promotionCompleted = false;

  let transactionResult: GedUploadTransactionResult;
  try {
    transactionResult = await withGedTransaction(async (tx: PoolClient) => {
      // Every writer takes the same transaction-scoped SHA lock before touching
      // the content-addressed path. It remains held through COMMIT/ROLLBACK.
      await repoLockGedBlobSha256(tx, expectedSha256);
      const written = await writeBlobFromPath(uploadedFile, expectedSha256);
      promotionCompleted = true;

      const duplicate = await repoFindDocumentByBlobHash(tx, written.sha256);
      if (duplicate) {
        throw new HttpError(
          409,
          "GED_FILE_DUPLICATE",
          `Ce fichier est déjà présent dans la GED sous le code ${duplicate.code}.`
        );
      }

      const blob = await repoUpsertBlob(tx, {
        sha256: written.sha256,
        size_bytes: written.size_bytes,
        mime_type: accepted.mime_type,
        storage_key: written.storage_key,
        created_by: actor.id,
      });

      const created = await repoCreateDocumentWithVersion(tx, {
        class_key: documentClass.class_key,
        domain: documentClass.domain,
        title: input.title,
        description: input.description ?? null,
        blob_id: blob.id,
        original_name: accepted.sanitized_name,
        change_reason: input.change_reason ?? null,
        created_by: actor.id,
      });

      if (input.link) {
        await repoAddLink(tx, {
          document_id: created.document_id,
          entity_type: input.link.entity_type,
          entity_id: input.link.entity_id,
          link_role: input.link.link_role ?? null,
          created_by: actor.id,
        });
      }

      await repoLogAccess(tx, {
        document_id: created.document_id,
        version_id: created.version_id,
        event_type: "UPLOAD",
        actor_id: actor.id,
        details: {
          class_key: documentClass.class_key,
          version_number: 1,
          size_bytes: written.size_bytes,
          sha256: written.sha256,
          deduplicated: written.deduplicated,
        },
      });

      return { documentId: created.document_id, versionId: created.version_id };
    }, uploadTransactionHooks(uploadedFiles, expectedSha256, () => promotionCompleted));
  } catch (err) {
    if (err instanceof GedCommitUncertainError) {
      transactionResult = await reconcileGedCommit(
        err as GedCommitUncertainError<GedUploadTransactionResult>,
        expectedSha256,
        storageKey,
        uploadedFiles
      );
    } else {
      // A rollback-uncertain error deliberately preserves the blob. All other
      // transaction failures already ran the confirmed-rollback hook.
      throw err;
    }
  }

  // Relecture APRÈS le commit : `repoGetDocumentDetail` ouvre sa propre
  // connexion et ne verrait rien d'une transaction encore ouverte.
  return readDetailOrFail(transactionResult.documentId);
}

export async function uploadNewVersion(
  actor: GedActor,
  documentId: string,
  input: { change_reason: string },
  file: UploadedFile | undefined
): Promise<GedDocumentDetail> {
  assertGedCapability(actor.role, "upload");

  const existing = await repoGetDocumentDetail(documentId);
  if (!existing) throw new HttpError(404, "GED_DOCUMENT_NOT_FOUND", "Document introuvable.");
  if (existing.archived_at) {
    throw new HttpError(409, "GED_DOCUMENT_ARCHIVED", "Un document archivé ne reçoit plus de version.");
  }
  if (existing.active_checkout && existing.active_checkout.held_by?.id !== actor.id) {
    throw new HttpError(
      409,
      "GED_CHECKOUT_HELD",
      `Document consigné par ${existing.active_checkout.held_by?.label ?? "un autre utilisateur"}.`
    );
  }

  const documentClass = await repoGetClass(existing.class_key);
  if (!documentClass) {
    throw new HttpError(400, "GED_CLASS_UNKNOWN", "Classe documentaire inconnue.");
  }

  const accepted = await assertAcceptedFileOnDisk(file, {
    class_key: documentClass.class_key,
    allowed_mime_types: documentClass.allowed_mime_types,
    allowed_extensions: documentClass.allowed_extensions,
    max_size_bytes: documentClass.max_size_bytes,
  });

  const uploadedFile = file as UploadedFile & { path: string };
  const uploadedFiles = [uploadedFile];
  const expectedSha256 = uploadedFile.uploadSecurity?.sha256
    ?? await computeFileSha256(uploadedFile.path);
  const storageKey = storageKeyForSha256(expectedSha256);
  let promotionCompleted = false;

  let transactionResult: GedUploadTransactionResult;
  try {
    transactionResult = await withGedTransaction(async (tx: PoolClient) => {
      await repoLockGedBlobSha256(tx, expectedSha256);
      const written = await writeBlobFromPath(uploadedFile, expectedSha256);
      promotionCompleted = true;

      const blob = await repoUpsertBlob(tx, {
        sha256: written.sha256,
        size_bytes: written.size_bytes,
        mime_type: accepted.mime_type,
        storage_key: written.storage_key,
        created_by: actor.id,
      });

      const version = await repoAddVersion(tx, {
        document_id: documentId,
        blob_id: blob.id,
        original_name: accepted.sanitized_name,
        change_reason: input.change_reason,
        created_by: actor.id,
      });

      await repoLogAccess(tx, {
        document_id: documentId,
        version_id: version.version_id,
        event_type: "UPLOAD",
        actor_id: actor.id,
        details: { version_number: version.version_number, sha256: written.sha256, size_bytes: written.size_bytes },
      });

      return { documentId, versionId: version.version_id };
    }, uploadTransactionHooks(uploadedFiles, expectedSha256, () => promotionCompleted));
  } catch (err) {
    if (err instanceof GedCommitUncertainError) {
      transactionResult = await reconcileGedCommit(
        err as GedCommitUncertainError<GedUploadTransactionResult>,
        expectedSha256,
        storageKey,
        uploadedFiles
      );
    } else {
      throw err;
    }
  }

  // Relecture APRÈS le commit, pour la même raison que dans `uploadDocument`.
  return readDetailOrFail(transactionResult.documentId);
}

/* -------------------------------------------------------------------------- */
/* Cycle de vie                                                               */
/* -------------------------------------------------------------------------- */

async function transitionVersion(
  actor: GedActor,
  versionId: string,
  target: GedVersionStatus,
  options: { comment?: string | null; requireDistinctApprover?: boolean }
): Promise<GedDocumentDetail> {
  const documentId = await withGedTransaction(async (tx) => {
    const version = await repoGetVersionForUpdate(tx, versionId);
    if (!version) throw new HttpError(404, "GED_VERSION_NOT_FOUND", "Version introuvable.");

    assertVersionTransition(version.status, target);

    if (options.requireDistinctApprover) {
      assertDistinctApprover(version.created_by, actor.id);
    }

    if (target === "APPLICABLE") {
      // Une seule version applicable : la précédente bascule OBSOLETE dans la
      // MÊME transaction. Jamais deux applicables, jamais zéro entre-temps.
      await repoObsoletePreviousApplicable(tx, version.document_id, version.id);
    }

    await repoSetVersionStatus(tx, version.id, target, actor.id);

    if (target === "APPLICABLE") {
      await repoSetCurrentVersion(tx, version.document_id, version.id);
    }

    if (target === "EN_REVUE") {
      await repoInsertApproval(tx, {
        version_id: version.id, decision: "SUBMITTED", comment: options.comment ?? null, decided_by: actor.id,
      });
    }
    if (target === "APPROUVE") {
      await repoInsertApproval(tx, {
        version_id: version.id, decision: "APPROVED", comment: options.comment ?? null, decided_by: actor.id,
      });
    }

    const eventByTarget: Record<string, string> = {
      EN_REVUE: "SUBMIT", APPROUVE: "APPROVE", APPLICABLE: "PUBLISH", OBSOLETE: "OBSOLETE", BROUILLON: "SUBMIT",
    };
    await repoLogAccess(tx, {
      document_id: version.document_id,
      version_id: version.id,
      event_type: eventByTarget[target] ?? "SUBMIT",
      actor_id: actor.id,
      details: { from: version.status, to: target, version_number: version.version_number },
    });

    return version.document_id;
  });

  // Relecture APRÈS le commit, pour la même raison que dans `uploadDocument`.
  return readDetailOrFail(documentId);
}

export async function submitVersion(actor: GedActor, versionId: string, comment: string | null) {
  assertGedCapability(actor.role, "submit");
  return transitionVersion(actor, versionId, "EN_REVUE", { comment });
}

export async function approveVersion(actor: GedActor, versionId: string, comment: string | null) {
  assertGedCapability(actor.role, "approve");
  return transitionVersion(actor, versionId, "APPROUVE", { comment, requireDistinctApprover: true });
}

export async function publishVersion(actor: GedActor, versionId: string) {
  assertGedCapability(actor.role, "publish");
  return transitionVersion(actor, versionId, "APPLICABLE", {});
}

export async function obsoleteVersion(actor: GedActor, versionId: string, reason: string | null) {
  assertGedCapability(actor.role, "obsolete");
  return transitionVersion(actor, versionId, "OBSOLETE", { comment: reason });
}

/* -------------------------------------------------------------------------- */
/* Téléchargement                                                             */
/* -------------------------------------------------------------------------- */

export type DownloadResult = {
  file_path: string;
  allowed_root: string;
  size_bytes: number;
  original_name: string;
  mime_type: string;
  sha256: string;
  document_id: string;
  version_id: string;
};

export async function downloadVersion(actor: GedActor, versionId: string): Promise<DownloadResult> {
  assertGedCapability(actor.role, "download");

  const ref = await repoInternalGetVersionContentRef(versionId);
  if (!ref) throw new HttpError(404, "GED_VERSION_NOT_FOUND", "Version introuvable.");

  // Un brouillon n'est jamais servi à qui n'a pas le droit de le voir : il n'est
  // pas encore un document opposable.
  if (ref.status === "BROUILLON") {
    assertGedCapability(actor.role, "upload");
  }

  const blob = await resolveBlobForDownload(ref.storage_key);

  return {
    file_path: blob.file_path,
    allowed_root: blob.allowed_root,
    size_bytes: ref.size_bytes,
    original_name: ref.original_name,
    mime_type: ref.mime_type,
    sha256: ref.sha256,
    document_id: ref.document_id,
    version_id: ref.version_id,
  };
}

export async function recordVersionDownload(
  actor: GedActor,
  result: DownloadResult,
  outcome: "DOWNLOAD" | "INTEGRITY_FAILURE"
): Promise<void> {
  await repoLogAccess(pool, {
    document_id: result.document_id,
    version_id: result.version_id,
    event_type: outcome,
    actor_id: actor.id,
    details: outcome === "DOWNLOAD"
      ? { size_bytes: result.size_bytes }
      : { expected_sha256: result.sha256 },
  }).catch(() => undefined);
}
