// GED centrale CERP (ADR-0037) — orchestration.
//
// Ordre invariant du dépôt : contrôle de contenu -> écriture du blob ->
// transaction base. Si la transaction échoue après l'écriture, le blob est
// compensé. L'inverse (base d'abord) laisserait des métadonnées sans fichier,
// c'est-à-dire des documents fantômes.

import type { PoolClient } from "pg";

import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { assertAcceptedFile } from "../domain/ged-content";
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
  repoGetClass,
  repoGetDocumentDetail,
  repoGetTree,
  repoGetVersionForUpdate,
  repoInsertApproval,
  repoInternalGetVersionContentRef,
  repoListAccessEvents,
  repoListClasses,
  repoListDocuments,
  repoLogAccess,
  repoObsoletePreviousApplicable,
  repoSetCurrentVersion,
  repoSetVersionStatus,
  repoUpsertBlob,
  withGedTransaction,
} from "../repository/ged.repository";
import type {
  GedAccessEvent,
  GedDocumentClass,
  GedDocumentDetail,
  GedListFilters,
  GedListResult,
  GedTreeNode,
} from "../types/ged.types";
import { checkVaultHealth, readBlob, removeBlobIfOrphan, writeBlob } from "./ged-vault.service";

export type GedActor = { id: number; role: string | null };

type UploadedFile = { buffer?: Buffer; originalname?: string; mimetype?: string; size?: number };

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

  const accepted = assertAcceptedFile(file, {
    class_key: documentClass.class_key,
    allowed_mime_types: documentClass.allowed_mime_types,
    allowed_extensions: documentClass.allowed_extensions,
    max_size_bytes: documentClass.max_size_bytes,
  });

  // 1) Écriture du contenu AVANT la transaction : un blob orphelin se détecte
  //    et se nettoie ; une métadonnée sans fichier est un mensonge durable.
  const written = await writeBlob(accepted.buffer);

  let documentId: string;
  try {
    documentId = await withGedTransaction(async (tx: PoolClient) => {
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

      return created.document_id;
    });
  } catch (err) {
    // Compensation : uniquement si le blob venait d'être créé par ce dépôt.
    if (!written.deduplicated) await removeBlobIfOrphan(written.storage_key);
    throw err;
  }

  // Relecture APRÈS le commit : `repoGetDocumentDetail` ouvre sa propre
  // connexion et ne verrait rien d'une transaction encore ouverte.
  return readDetailOrFail(documentId);
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

  const accepted = assertAcceptedFile(file, {
    class_key: documentClass.class_key,
    allowed_mime_types: documentClass.allowed_mime_types,
    allowed_extensions: documentClass.allowed_extensions,
    max_size_bytes: documentClass.max_size_bytes,
  });

  const written = await writeBlob(accepted.buffer);

  try {
    await withGedTransaction(async (tx: PoolClient) => {
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

    });
  } catch (err) {
    if (!written.deduplicated) await removeBlobIfOrphan(written.storage_key);
    throw err;
  }

  // Relecture APRÈS le commit, pour la même raison que dans `uploadDocument`.
  return readDetailOrFail(documentId);
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
  buffer: Buffer;
  original_name: string;
  mime_type: string;
  sha256: string;
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

  let buffer: Buffer;
  try {
    // L'empreinte est RECALCULÉE ici : un fichier altéré sur disque est refusé.
    buffer = await readBlob(ref.storage_key, ref.sha256);
  } catch (err) {
    if (err instanceof HttpError && err.code === "GED_INTEGRITY") {
      // Une atteinte à l'intégrité est un événement de sécurité : elle est
      // journalisée même si la lecture échoue.
      await repoLogAccess(pool, {
        document_id: ref.document_id,
        version_id: ref.version_id,
        event_type: "INTEGRITY_FAILURE",
        actor_id: actor.id,
        details: { expected_sha256: ref.sha256 },
      }).catch(() => undefined);
    }
    throw err;
  }

  // Le journal ne doit jamais faire échouer un téléchargement légitime.
  await repoLogAccess(pool, {
    document_id: ref.document_id,
    version_id: ref.version_id,
    event_type: "DOWNLOAD",
    actor_id: actor.id,
    details: { size_bytes: buffer.byteLength },
  }).catch(() => undefined);

  return {
    buffer,
    original_name: ref.original_name,
    mime_type: ref.mime_type,
    sha256: ref.sha256,
  };
}
