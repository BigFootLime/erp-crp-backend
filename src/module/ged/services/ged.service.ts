// GED centrale CERP (ADR-0037) — orchestration.
//
// Ordre invariant du dépôt : contrôle + empreinte -> transaction + verrou SHA
// -> promotion du blob -> métadonnées -> COMMIT. Une compensation post-rollback
// reprend le même verrou sur une connexion fraîche avant de décider de supprimer
// ou préserver le blob partagé.

import crypto from "node:crypto";
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
import { scanUpload, type UploadScanResult } from "../../../shared/uploads/upload-scanner";
import { observeDocumentScan } from "../../../shared/observability/metrics";
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
  repoCreateUploadSession,
  repoClearQuarantineKey,
  repoFinalizeUploadSession,
  repoFindDocumentByBlobHash,
  repoGetGedBlobReferenceState,
  repoGetQuarantineSession,
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
  repoListQuarantine,
  repoLogAccess,
  repoMarkQuarantineDeleted,
  repoObsoletePreviousApplicable,
  repoGetQuarantineSessionForUpdate,
  repoRecordUploadScan,
  repoSetCurrentVersion,
  repoSetVersionStatus,
  repoUpsertBlob,
  withGedBlobSha256Coordination,
  withGedTransaction,
  GedBlobCleanupUncertainError,
  GedCommitUncertainError,
  type GedUploadSessionInternal,
} from "../repository/ged.repository";
import { assertGedVersionParentReadable } from "./ged-parent-authorization.service";
import type {
  GedAccessEvent,
  GedDocumentClass,
  GedDocumentDetail,
  GedListFilters,
  GedListResult,
  GedQuarantineItem,
  GedTreeNode,
} from "../types/ged.types";
import {
  checkVaultHealth,
  cleanupQuarantineReleaseStaging,
  computeFileSha256,
  deleteQuarantinedFile,
  persistQuarantinedUpload,
  resolveBlobForDownload,
  resolveQuarantinedFile,
  stageQuarantinedFileForRelease,
  storageKeyForSha256,
  writeBlobFromPath,
} from "./ged-vault.service";

export type GedActor = { id: number; role: string | null };

type UploadedFile = {
  path?: string;
  originalname?: string;
  mimetype?: string;
  size?: number;
  uploadSecurity?: { sha256: string; scanStatus?: string };
};
type GedUploadTransactionResult = { documentId: string; versionId: string };
type PersistedScanVerdict = Awaited<ReturnType<typeof scanUpload>>;
type DeferredScan = Readonly<{
  sessionId: string;
  verdict: PersistedScanVerdict;
  quarantineKey: string;
  releaseFile: UploadedFile & { path: string };
}>;

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

async function prepareDeferredScan(
  actor: GedActor,
  file: UploadedFile & { path: string },
  input: {
    class_key: string;
    document_id: string | null;
    title: string | null;
    mime_type: string;
    size_bytes: number;
    original_name: string;
    request_metadata: Record<string, unknown>;
  }
): Promise<DeferredScan | null> {
  if (file.uploadSecurity?.scanStatus !== "pending") return null;

  // A durable quarantine must exist before the DB advertises a pending scan.
  const sha256 = file.uploadSecurity.sha256;
  const sessionId = crypto.randomUUID();
  const quarantined = await persistQuarantinedUpload(file as Express.Multer.File, sessionId);
  const files = [file];
  const pending = await withGedTransaction(
    async (tx) => {
      const session = await repoCreateUploadSession(tx, {
        id: sessionId,
        ...input,
        sha256,
        quarantine_key: quarantined.quarantine_key,
        created_by: actor.id,
      });
      await repoLogAccess(tx, {
        document_id: input.document_id,
        version_id: null,
        event_type: "SCAN_PENDING",
        actor_id: actor.id,
        details: {
          session_id: session.id,
          class_key: input.class_key,
          size_bytes: input.size_bytes,
          source: "server_upload_scanner",
          reliability: "MEASURED",
        },
      });
      return session;
    },
    {
      afterCommit: () => markUploadsCommitted(files),
      afterConfirmedRollback: () => cleanupUploadsAfterConfirmedRollback(files),
      afterRollbackUncertain: () => markUploadRollbackUncertain(files),
    }
  );

  const verdict = await scanUpload({ path: quarantined.file_path });
  observeDocumentScan(verdict.status, verdict.duration_ms);
  if (verdict.status === "clean") {
    const stagingPath = await stageQuarantinedFileForRelease(quarantined.quarantine_key, sha256);
    return {
      sessionId: pending.id,
      verdict,
      quarantineKey: quarantined.quarantine_key,
      releaseFile: {
        path: stagingPath,
        originalname: input.original_name,
        mimetype: input.mime_type,
        size: input.size_bytes,
        uploadSecurity: { sha256, scanStatus: "clean" },
      },
    };
  }

  const scanStatus = verdict.status === "infected" ? "infected" : "scan_failed";
  const eventType = verdict.status === "infected" ? "SCAN_INFECTED" : "SCAN_FAILED";
  await withGedTransaction(async (tx) => {
      await repoRecordUploadScan(tx, {
        session_id: pending.id,
        status: "QUARANTINE",
        scan_status: scanStatus,
        quarantine_status: "quarantined",
        scan_provider: verdict.provider,
        signature_version: verdict.signature_version ?? null,
        scan_duration_ms: verdict.duration_ms,
        quarantine_key: quarantined.quarantine_key,
        reject_reason: verdict.reason ?? scanStatus,
      });
      const details = {
        session_id: pending.id,
        provider: verdict.provider,
        signature_version: verdict.signature_version ?? null,
        duration_ms: verdict.duration_ms,
        reason_code: verdict.reason ?? scanStatus,
        source: "server_upload_scanner",
        freshness_at: new Date().toISOString(),
        reliability: "MEASURED",
      };
      await repoLogAccess(tx, {
        document_id: input.document_id,
        version_id: null,
        event_type: eventType,
        actor_id: actor.id,
        details,
      });
      await repoLogAccess(tx, {
        document_id: input.document_id,
        version_id: null,
        event_type: "QUARANTINED",
        actor_id: actor.id,
        details: { ...details, scan_status: scanStatus },
      });
    });

  logger.warn("[GED_ANTIVIRUS_QUARANTINE]", {
    quarantine_id: pending.id,
    scan_status: scanStatus,
    provider: verdict.provider,
    duration_ms: verdict.duration_ms,
    actor_id: actor.id,
  });

  if (verdict.status === "infected") {
    throw new HttpError(
      422,
      "GED_SCAN_INFECTED",
      "Le fichier est infecté ou suspect. Il reste isolé et ne peut pas être consulté.",
      { quarantine_id: pending.id, state: "quarantined" }
    );
  }
  throw new HttpError(
    503,
    "GED_SCAN_FAILED",
    "Le verdict antivirus n'a pas pu être obtenu. Le fichier reste isolé en quarantaine.",
    { quarantine_id: pending.id, state: "quarantined" }
  );
}

async function recordCleanScan(
  tx: Pick<PoolClient, "query">,
  actor: GedActor,
  scan: DeferredScan,
  documentId: string | null,
  versionId: string | null
): Promise<void> {
  await repoRecordUploadScan(tx, {
    session_id: scan.sessionId,
    status: "READY",
    scan_status: "clean",
    quarantine_status: "quarantined",
    scan_provider: scan.verdict.provider,
    signature_version: scan.verdict.signature_version ?? null,
    scan_duration_ms: scan.verdict.duration_ms,
    quarantine_key: scan.quarantineKey,
    reject_reason: null,
  });
  await repoLogAccess(tx, {
    document_id: documentId,
    version_id: versionId,
    event_type: "SCAN_CLEAN",
    actor_id: actor.id,
    details: {
      session_id: scan.sessionId,
      provider: scan.verdict.provider,
      signature_version: scan.verdict.signature_version ?? null,
      duration_ms: scan.verdict.duration_ms,
      source: "server_upload_scanner",
      freshness_at: new Date().toISOString(),
      reliability: "MEASURED",
    },
  });
}

async function cleanupPublishedQuarantine(scan: DeferredScan): Promise<void> {
  try {
    await deleteQuarantinedFile(scan.quarantineKey);
    await repoClearQuarantineKey(scan.sessionId);
  } catch (error) {
    logger.error("[GED_QUARANTINE_RELEASE_CLEANUP_FAILED]", {
      quarantine_id: scan.sessionId,
      error: error instanceof Error ? error.name : "unknown",
    });
  }
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

function publicQuarantineItem(session: GedUploadSessionInternal): GedQuarantineItem {
  const {
    status: _status,
    mime_type: _mimeType,
    quarantine_key: _quarantineKey,
    request_metadata: _requestMetadata,
    document_id: _documentId,
    reject_reason: _rejectReason,
    ...item
  } = session;
  return item;
}

export async function listQuarantine(actor: GedActor): Promise<GedQuarantineItem[]> {
  assertGedCapability(actor.role, "admin");
  return (await repoListQuarantine()).map(publicQuarantineItem);
}

export async function rescanQuarantine(actor: GedActor, sessionId: string): Promise<GedQuarantineItem> {
  assertGedCapability(actor.role, "admin");
  const before = await repoGetQuarantineSession(sessionId);
  if (!before || before.quarantine_status !== "quarantined" || !before.quarantine_key) {
    throw new HttpError(404, "GED_QUARANTINE_NOT_FOUND", "Fichier de quarantaine introuvable.");
  }
  const filePath = await resolveQuarantinedFile(before.quarantine_key);
  const verdict = await scanUpload({ path: filePath });
  observeDocumentScan(verdict.status, verdict.duration_ms);
  const scanStatus = verdict.status === "unavailable" ? "scan_failed" : verdict.status;

  await withGedTransaction(async (tx) => {
    const locked = await repoGetQuarantineSessionForUpdate(tx, sessionId);
    if (
      !locked
      || locked.quarantine_status !== "quarantined"
      || locked.quarantine_key !== before.quarantine_key
      || locked.sha256 !== before.sha256
    ) {
      throw new HttpError(409, "GED_QUARANTINE_STATE", "La quarantaine a changé pendant la réanalyse.");
    }
    await repoRecordUploadScan(tx, {
      session_id: sessionId,
      status: scanStatus === "clean" ? "READY" : "QUARANTINE",
      scan_status: scanStatus,
      quarantine_status: "quarantined",
      scan_provider: verdict.provider,
      signature_version: verdict.signature_version ?? null,
      scan_duration_ms: verdict.duration_ms,
      quarantine_key: locked.quarantine_key,
      reject_reason: scanStatus === "clean" ? null : verdict.reason ?? scanStatus,
    });
    await repoLogAccess(tx, {
      document_id: locked.document_id,
      version_id: null,
      event_type: scanStatus === "clean" ? "SCAN_CLEAN" : scanStatus === "infected" ? "SCAN_INFECTED" : "SCAN_FAILED",
      actor_id: actor.id,
      details: {
        session_id: sessionId,
        provider: verdict.provider,
        signature_version: verdict.signature_version ?? null,
        duration_ms: verdict.duration_ms,
        reason_code: verdict.reason ?? null,
        action: "admin_rescan",
        source: "server_upload_scanner",
        reliability: "MEASURED",
      },
    });
  });

  const updated = await repoGetQuarantineSession(sessionId);
  if (!updated) throw new HttpError(404, "GED_QUARANTINE_NOT_FOUND", "Fichier de quarantaine introuvable.");
  return publicQuarantineItem(updated);
}

type ReleaseLink = { entity_type: string; entity_id: string; link_role: string | null };
type ReleaseMetadata =
  | { kind: "new_document"; description: string | null; change_reason: string | null; link: ReleaseLink | null }
  | { kind: "new_version"; document_id: string; change_reason: string };

function releaseMetadata(session: GedUploadSessionInternal): ReleaseMetadata {
  const metadata = session.request_metadata;
  if (!metadata || typeof metadata.kind !== "string") {
    throw new HttpError(409, "GED_QUARANTINE_METADATA", "Les métadonnées de reprise sont incomplètes.");
  }
  if (metadata.kind === "new_version") {
    if (typeof metadata.document_id !== "string" || typeof metadata.change_reason !== "string") {
      throw new HttpError(409, "GED_QUARANTINE_METADATA", "Les métadonnées de version sont incomplètes.");
    }
    return { kind: "new_version", document_id: metadata.document_id, change_reason: metadata.change_reason };
  }
  if (metadata.kind !== "new_document") {
    throw new HttpError(409, "GED_QUARANTINE_METADATA", "Le type de reprise est inconnu.");
  }
  const linkValue = metadata.link;
  let link: ReleaseLink | null = null;
  if (linkValue && typeof linkValue === "object" && !Array.isArray(linkValue)) {
    const candidate = linkValue as Record<string, unknown>;
    if (typeof candidate.entity_type !== "string" || typeof candidate.entity_id !== "string") {
      throw new HttpError(409, "GED_QUARANTINE_METADATA", "Le lien métier de reprise est invalide.");
    }
    link = {
      entity_type: candidate.entity_type,
      entity_id: candidate.entity_id,
      link_role: typeof candidate.link_role === "string" ? candidate.link_role : null,
    };
  }
  return {
    kind: "new_document",
    description: typeof metadata.description === "string" ? metadata.description : null,
    change_reason: typeof metadata.change_reason === "string" ? metadata.change_reason : null,
    link,
  };
}

export async function releaseQuarantine(actor: GedActor, sessionId: string): Promise<GedDocumentDetail> {
  assertGedCapability(actor.role, "admin");
  const session = await repoGetQuarantineSession(sessionId);
  if (!session || session.quarantine_status !== "quarantined" || !session.quarantine_key) {
    throw new HttpError(404, "GED_QUARANTINE_NOT_FOUND", "Fichier de quarantaine introuvable.");
  }
  if (session.scan_status !== "clean" || !session.sha256 || !session.mime_type || !session.original_name) {
    throw new HttpError(409, "GED_SCAN_REQUIRED", "Une réanalyse saine est obligatoire avant libération.");
  }
  const quarantineKey = session.quarantine_key;
  const sha256 = session.sha256;
  const mimeType = session.mime_type;
  const originalName = session.original_name;
  const metadata = releaseMetadata(session);
  const documentClass = await repoGetClass(session.class_key);
  if (!documentClass) throw new HttpError(400, "GED_CLASS_UNKNOWN", "Classe documentaire inconnue.");
  if (metadata.kind === "new_version") {
    const existing = await repoGetDocumentDetail(metadata.document_id);
    if (!existing || existing.archived_at) {
      throw new HttpError(409, "GED_DOCUMENT_ARCHIVED", "Le document cible n'accepte plus de version.");
    }
  }

  const stagingPath = await stageQuarantinedFileForRelease(quarantineKey, sha256);
  const releaseFile = {
    path: stagingPath,
    originalname: originalName,
    mimetype: mimeType,
    size: session.size_bytes ?? 0,
    uploadSecurity: { sha256, scanStatus: "clean" },
  } as UploadedFile & { path: string };
  const releaseFiles = [releaseFile];
  const storageKey = storageKeyForSha256(sha256);
  let promotionCompleted = false;
  let transactionResult: GedUploadTransactionResult;

  try {
    transactionResult = await withGedTransaction(async (tx) => {
      const locked = await repoGetQuarantineSessionForUpdate(tx, sessionId);
      if (
        !locked
        || locked.quarantine_status !== "quarantined"
        || locked.scan_status !== "clean"
        || locked.sha256 !== sha256
        || locked.quarantine_key !== quarantineKey
      ) {
        throw new HttpError(409, "GED_QUARANTINE_STATE", "La quarantaine a changé pendant sa libération.");
      }

      await repoLockGedBlobSha256(tx, sha256);
      if (metadata.kind === "new_document") {
        const duplicate = await repoFindDocumentByBlobHash(tx, sha256);
        if (duplicate) {
          throw new HttpError(409, "GED_FILE_DUPLICATE", `Ce fichier existe déjà sous le code ${duplicate.code}.`);
        }
      }
      const written = await writeBlobFromPath(releaseFile, sha256);
      promotionCompleted = true;
      const blob = await repoUpsertBlob(tx, {
        sha256: written.sha256,
        size_bytes: written.size_bytes,
        mime_type: mimeType,
        storage_key: written.storage_key,
        created_by: actor.id,
      });

      let created: GedUploadTransactionResult;
      if (metadata.kind === "new_document") {
        if (!session.title) throw new HttpError(409, "GED_QUARANTINE_METADATA", "Le titre du document manque.");
        const document = await repoCreateDocumentWithVersion(tx, {
          class_key: session.class_key,
          domain: documentClass.domain,
          title: session.title,
          description: metadata.description,
          blob_id: blob.id,
          original_name: originalName,
          change_reason: metadata.change_reason,
          created_by: actor.id,
          upload_session_id: sessionId,
        });
        if (metadata.link) {
          await repoAddLink(tx, { document_id: document.document_id, ...metadata.link, created_by: actor.id });
        }
        created = { documentId: document.document_id, versionId: document.version_id };
      } else {
        const version = await repoAddVersion(tx, {
          document_id: metadata.document_id,
          blob_id: blob.id,
          original_name: originalName,
          change_reason: metadata.change_reason,
          created_by: actor.id,
          upload_session_id: sessionId,
        });
        created = { documentId: metadata.document_id, versionId: version.version_id };
      }

      await repoFinalizeUploadSession(tx, sessionId, created.documentId, false);
      await repoLogAccess(tx, {
        document_id: created.documentId,
        version_id: created.versionId,
        event_type: "QUARANTINE_RELEASED",
        actor_id: actor.id,
        details: { session_id: sessionId, release_kind: "admin_after_clean_rescan" },
      });
      await repoLogAccess(tx, {
        document_id: created.documentId,
        version_id: created.versionId,
        event_type: "UPLOAD",
        actor_id: actor.id,
        details: { session_id: sessionId, sha256: written.sha256, size_bytes: written.size_bytes },
      });
      return created;
    }, uploadTransactionHooks(releaseFiles, session.sha256, () => promotionCompleted));
  } catch (error) {
    if (error instanceof GedCommitUncertainError) {
      transactionResult = await reconcileGedCommit(
        error as GedCommitUncertainError<GedUploadTransactionResult>,
        session.sha256,
        storageKey,
        releaseFiles
      );
    } else {
      throw error;
    }
  } finally {
    await cleanupQuarantineReleaseStaging(stagingPath).catch(() => undefined);
  }

  try {
    await deleteQuarantinedFile(session.quarantine_key);
    await repoClearQuarantineKey(sessionId);
  } catch (error) {
    logger.error("[GED_QUARANTINE_RELEASE_CLEANUP_FAILED]", {
      quarantine_id: sessionId,
      error: error instanceof Error ? error.name : "unknown",
    });
  }
  return readDetailOrFail(transactionResult.documentId);
}

export async function deleteQuarantine(actor: GedActor, sessionId: string): Promise<void> {
  assertGedCapability(actor.role, "admin");
  const session = await repoGetQuarantineSession(sessionId);
  if (!session || !session.quarantine_key || !["quarantined", "deleted"].includes(session.quarantine_status)) {
    throw new HttpError(404, "GED_QUARANTINE_NOT_FOUND", "Fichier de quarantaine introuvable.");
  }

  if (session.quarantine_status === "quarantined") {
    await withGedTransaction(async (tx) => {
      const locked = await repoGetQuarantineSessionForUpdate(tx, sessionId);
      if (!locked || locked.quarantine_status !== "quarantined" || locked.quarantine_key !== session.quarantine_key) {
        throw new HttpError(409, "GED_QUARANTINE_STATE", "La quarantaine a changé pendant la suppression.");
      }
      await repoMarkQuarantineDeleted(tx, sessionId, "admin_delete");
      await repoLogAccess(tx, {
        document_id: locked.document_id,
        version_id: null,
        event_type: "QUARANTINE_DELETED",
        actor_id: actor.id,
        details: { session_id: sessionId },
      });
    });
  }

  try {
    await deleteQuarantinedFile(session.quarantine_key);
  } catch (error) {
    if (!(error instanceof HttpError) || error.code !== "GED_QUARANTINE_FILE_MISSING") throw error;
  }
  await repoClearQuarantineKey(sessionId);
}

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
  const expectedSha256 = uploadedFile.uploadSecurity?.sha256
    ?? await computeFileSha256(uploadedFile.path);
  const deferredScan = await prepareDeferredScan(actor, uploadedFile, {
    class_key: documentClass.class_key,
    document_id: null,
    title: input.title,
    mime_type: accepted.mime_type,
    size_bytes: accepted.size_bytes,
    original_name: accepted.sanitized_name,
    request_metadata: {
      kind: "new_document",
      description: input.description ?? null,
      change_reason: input.change_reason ?? null,
      link: input.link ?? null,
    },
  });
  const publicationFile = deferredScan?.releaseFile ?? uploadedFile;
  const publicationFiles = [publicationFile];
  const storageKey = storageKeyForSha256(expectedSha256);
  let promotionCompleted = false;

  let transactionResult: GedUploadTransactionResult;
  try {
    transactionResult = await withGedTransaction(async (tx: PoolClient) => {
      // Every writer takes the same transaction-scoped SHA lock before touching
      // the content-addressed path. It remains held through COMMIT/ROLLBACK.
      await repoLockGedBlobSha256(tx, expectedSha256);
      if (deferredScan) await recordCleanScan(tx, actor, deferredScan, null, null);
      const written = await writeBlobFromPath(publicationFile, expectedSha256);
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
        upload_session_id: deferredScan?.sessionId ?? null,
      });

      if (deferredScan) {
        await repoFinalizeUploadSession(tx, deferredScan.sessionId, created.document_id, false);
        await repoLogAccess(tx, {
          document_id: created.document_id,
          version_id: created.version_id,
          event_type: "QUARANTINE_RELEASED",
          actor_id: actor.id,
          details: { session_id: deferredScan.sessionId, release_kind: "automatic_clean_verdict" },
        });
      }

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
          antivirus_scan_status: deferredScan ? "clean" : "legacy_middleware_scan",
          antivirus_session_id: deferredScan?.sessionId ?? null,
        },
      });

      return { documentId: created.document_id, versionId: created.version_id };
    }, uploadTransactionHooks(publicationFiles, expectedSha256, () => promotionCompleted));
  } catch (err) {
    if (err instanceof GedCommitUncertainError) {
      transactionResult = await reconcileGedCommit(
        err as GedCommitUncertainError<GedUploadTransactionResult>,
        expectedSha256,
        storageKey,
        publicationFiles
      );
    } else {
      // A rollback-uncertain error deliberately preserves the blob. All other
      // transaction failures already ran the confirmed-rollback hook.
      throw err;
    }
  }

  if (deferredScan) await cleanupPublishedQuarantine(deferredScan);
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
  const expectedSha256 = uploadedFile.uploadSecurity?.sha256
    ?? await computeFileSha256(uploadedFile.path);
  const deferredScan = await prepareDeferredScan(actor, uploadedFile, {
    class_key: documentClass.class_key,
    document_id: documentId,
    title: existing.title,
    mime_type: accepted.mime_type,
    size_bytes: accepted.size_bytes,
    original_name: accepted.sanitized_name,
    request_metadata: {
      kind: "new_version",
      document_id: documentId,
      change_reason: input.change_reason,
    },
  });
  const publicationFile = deferredScan?.releaseFile ?? uploadedFile;
  const publicationFiles = [publicationFile];
  const storageKey = storageKeyForSha256(expectedSha256);
  let promotionCompleted = false;

  let transactionResult: GedUploadTransactionResult;
  try {
    transactionResult = await withGedTransaction(async (tx: PoolClient) => {
      await repoLockGedBlobSha256(tx, expectedSha256);
      if (deferredScan) await recordCleanScan(tx, actor, deferredScan, documentId, null);
      const written = await writeBlobFromPath(publicationFile, expectedSha256);
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
        upload_session_id: deferredScan?.sessionId ?? null,
      });

      if (deferredScan) {
        await repoFinalizeUploadSession(tx, deferredScan.sessionId, documentId, false);
        await repoLogAccess(tx, {
          document_id: documentId,
          version_id: version.version_id,
          event_type: "QUARANTINE_RELEASED",
          actor_id: actor.id,
          details: { session_id: deferredScan.sessionId, release_kind: "automatic_clean_verdict" },
        });
      }

      await repoLogAccess(tx, {
        document_id: documentId,
        version_id: version.version_id,
        event_type: "UPLOAD",
        actor_id: actor.id,
        details: {
          version_number: version.version_number,
          sha256: written.sha256,
          size_bytes: written.size_bytes,
          antivirus_scan_status: deferredScan ? "clean" : "legacy_middleware_scan",
          antivirus_session_id: deferredScan?.sessionId ?? null,
        },
      });

      return { documentId, versionId: version.version_id };
    }, uploadTransactionHooks(publicationFiles, expectedSha256, () => promotionCompleted));
  } catch (err) {
    if (err instanceof GedCommitUncertainError) {
      transactionResult = await reconcileGedCommit(
        err as GedCommitUncertainError<GedUploadTransactionResult>,
        expectedSha256,
        storageKey,
        publicationFiles
      );
    } else {
      throw err;
    }
  }

  if (deferredScan) await cleanupPublishedQuarantine(deferredScan);
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

  if (
    (ref.scan_status !== null && ref.scan_status !== "clean")
    || ref.quarantine_status === "quarantined"
  ) {
    throw new HttpError(
      409,
      "GED_SCAN_REQUIRED",
      "Le document reste bloqué tant que son analyse antivirus n'est pas validée."
    );
  }

  // Un brouillon n'est jamais servi à qui n'a pas le droit de le voir : il n'est
  // pas encore un document opposable.
  if (ref.status === "BROUILLON") {
    assertGedCapability(actor.role, "upload");
  }

  // Global GED capability is not a parent-record grant. Require one known,
  // live parent and that module's current entitlement before storage is even
  // resolved, so a guessed version UUID cannot become an IDOR primitive.
  await assertGedVersionParentReadable(actor.id, ref.document_id);

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

/** Durable receipt that must succeed before the controller sends any bytes. */
export async function recordVersionDownloadAuthorized(actor: GedActor, result: DownloadResult): Promise<void> {
  await repoLogAccess(pool, {
    document_id: result.document_id,
    version_id: result.version_id,
    event_type: "READ",
    actor_id: actor.id,
    details: { delivery: "authorized", size_bytes: result.size_bytes },
  });
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
  });
}
