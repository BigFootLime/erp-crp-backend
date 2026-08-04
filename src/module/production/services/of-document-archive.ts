// Archivage GED du document d'OF émis (#370, ADR-0037).
//
// Un document d'OF officiel est une pièce opposable : il accompagne la
// fabrication et doit pouvoir être restitué des années plus tard, à l'octet
// près. L'archivage suit donc deux principes :
//
//   1. Le coffre est adressé par contenu. Le blob est stocké sous l'empreinte du
//      binaire : deux dépôts du même document convergent, et un fichier altéré
//      sur disque est refusé à la lecture au lieu d'être servi.
//   2. L'empreinte est la référence, le coffre est la commodité. `of_documents`
//      porte `pdf_sha256` en propre. Si le coffre n'est pas configuré — poste de
//      développement, environnement de test — l'émission n'échoue pas : le
//      document reste réimprimable depuis son payload figé, et la réimpression
//      est vérifiée contre l'empreinte enregistrée.
//
// C'est ce second point qui évite de faire dépendre une règle métier (« une
// réimpression restitue exactement le document émis ») d'une variable
// d'environnement.

import type { PoolClient } from "pg";

import {
  GedBlobCleanupUncertainError,
  repoAddVersion,
  repoCreateDocumentWithVersion,
  repoGetGedBlobReferenceState,
  repoLockGedBlobSha256,
  repoSetCurrentVersion,
  repoUpsertBlob,
  withGedBlobSha256Coordination,
} from "../../ged/repository/ged.repository";
import {
  cleanupOwnedVaultBlob,
  computeSha256,
  isVaultConfigured,
  readBlob,
  storageKeyForSha256,
  writeBlob,
  type VaultBlobOwnership,
} from "../../ged/services/ged-vault.service";

/** Classe GED du dossier atelier — déjà présente au référentiel. */
const OF_DOCUMENT_CLASS_KEY = "OF_DOSSIER";
const OF_DOCUMENT_DOMAIN = "PRODUCTION";

export type OfDocumentArchiveInput = {
  ofNumero: string;
  revisionCode: string;
  pieceReference: string | null;
  pdf: Buffer;
  pdfSha256: string;
  /** Document GED existant à versionner, si cet OF en a déjà un. */
  existingGedDocumentId: string | null;
  actorUserId: number | null;
  changeReason: string | null;
};

export type OfDocumentArchiveResult = {
  archived: boolean;
  gedDocumentId: string | null;
  gedVersionId: string | null;
  /** Pourquoi l'archivage n'a pas eu lieu, quand il n'a pas eu lieu. */
  skippedReason: string | null;
  /** Internal transaction ownership; must never be serialized by controllers. */
  blobOwnership: VaultBlobOwnership | null;
  blobSha256: string | null;
  blobStorageKey: string | null;
};

export type PublicOfDocumentArchiveResult = Omit<
  OfDocumentArchiveResult,
  "blobOwnership" | "blobSha256" | "blobStorageKey"
>;

export type OfDocumentArchiveOwnershipObserver = (
  ownership: OfDocumentArchiveResult
) => void;

export function publicOfDocumentArchiveResult(
  archive: PublicOfDocumentArchiveResult & Partial<Pick<
    OfDocumentArchiveResult,
    "blobOwnership" | "blobSha256" | "blobStorageKey"
  >>
): PublicOfDocumentArchiveResult {
  const {
    blobOwnership: _blobOwnership,
    blobSha256: _blobSha256,
    blobStorageKey: _blobStorageKey,
    ...publicResult
  } = archive;
  return publicResult;
}

/**
 * Compensate only a blob inode created by this OF emission, after the OF
 * transaction has a confirmed non-commit outcome. The fresh transaction takes
 * the same SHA lock and rechecks all GED references before filesystem cleanup.
 */
export async function compensateOfDocumentArchive(
  archive: OfDocumentArchiveResult | null
): Promise<void> {
  if (
    !archive?.blobSha256
    || !archive.blobOwnership
    || archive.blobOwnership.kind === "deduplicated"
  ) return;

  try {
    await withGedBlobSha256Coordination(archive.blobSha256, async (tx) => {
      const state = await repoGetGedBlobReferenceState(tx, archive.blobSha256!);
      if (state.blob_present || state.reference_count > 0) return;
      await cleanupOwnedVaultBlob(archive.blobOwnership!);
    });
  } catch (error) {
    throw new GedBlobCleanupUncertainError(error);
  }
}

/**
 * Verse le PDF au coffre et l'enregistre en GED, dans la transaction fournie.
 *
 * Le verrou transactionnel de l'empreinte est acquis AVANT l'écriture du blob,
 * puis conservé jusqu'au COMMIT/ROLLBACK de l'appelant. L'écriture reste antérieure
 * à l'insertion : une référence GED sans fichier affirmerait une conservation
 * qui n'existe pas.
 */
export async function archiveOfDocument(
  tx: Pick<PoolClient, "query">,
  input: OfDocumentArchiveInput,
  observeOwnership?: OfDocumentArchiveOwnershipObserver
): Promise<OfDocumentArchiveResult> {
  if (!isVaultConfigured()) {
    return {
      archived: false,
      gedDocumentId: null,
      gedVersionId: null,
      skippedReason:
        "Coffre documentaire non configuré : le document reste réimprimable depuis son payload figé et vérifié contre son empreinte.",
      blobOwnership: null,
      blobSha256: null,
      blobStorageKey: null,
    };
  }

  // Snapshot the mutable Buffer and validate its identity before taking a lock
  // or creating a durable path. The private copy cannot change while awaiting
  // another writer of the same content.
  const pdf = Buffer.from(input.pdf);
  const pdfSha256 = computeSha256(pdf);
  if (pdfSha256 !== input.pdfSha256) {
    throw new Error("Empreinte incohérente avant archivage GED du document d’OF.");
  }

  // Participate in the same transaction-scoped SHA protocol as HTTP GED
  // uploads. Promotion must happen only after this lock is acquired and the
  // lock remains held by the caller's transaction through COMMIT/ROLLBACK.
  await repoLockGedBlobSha256(tx, pdfSha256);
  const written = await writeBlob(pdf);
  // Publish filesystem ownership to the transaction orchestrator immediately:
  // any later GED insert can fail before this function returns, but cleanup is
  // still forbidden until the caller confirms ROLLBACK on its SQL transaction.
  observeOwnership?.({
    archived: false,
    gedDocumentId: null,
    gedVersionId: null,
    skippedReason: null,
    blobOwnership: written.ownership,
    blobSha256: written.sha256,
    blobStorageKey: written.storage_key,
  });

  const blob = await repoUpsertBlob(tx, {
    sha256: written.sha256,
    size_bytes: written.size_bytes,
    mime_type: "application/pdf",
    storage_key: written.storage_key,
    created_by: input.actorUserId,
  });

  const title = `Gamme de fabrication ${input.ofNumero} ${input.revisionCode}`;
  const originalName = `OF-${input.ofNumero}-${input.revisionCode}.pdf`.replace(/\s+/g, "");

  // Un OF garde UN document GED et gagne une version par révision émise :
  // l'historique documentaire suit ainsi l'historique des révisions au lieu de
  // se disperser en documents sans lien entre eux.
  if (input.existingGedDocumentId) {
    const version = await repoAddVersion(tx, {
      document_id: input.existingGedDocumentId,
      blob_id: blob.id,
      original_name: originalName,
      change_reason: input.changeReason,
      created_by: input.actorUserId,
    });
    await repoSetCurrentVersion(tx, input.existingGedDocumentId, version.version_id);
    return {
      archived: true,
      gedDocumentId: input.existingGedDocumentId,
      gedVersionId: version.version_id,
      skippedReason: null,
      blobOwnership: written.ownership,
      blobSha256: written.sha256,
      blobStorageKey: written.storage_key,
    };
  }

  const created = await repoCreateDocumentWithVersion(tx, {
    class_key: OF_DOCUMENT_CLASS_KEY,
    domain: OF_DOCUMENT_DOMAIN,
    title,
    description: input.pieceReference ? `Pièce ${input.pieceReference}` : null,
    blob_id: blob.id,
    original_name: originalName,
    change_reason: input.changeReason,
    created_by: input.actorUserId,
  });

  return {
    archived: true,
    gedDocumentId: created.document_id,
    gedVersionId: created.version_id,
    skippedReason: null,
    blobOwnership: written.ownership,
    blobSha256: written.sha256,
    blobStorageKey: written.storage_key,
  };
}

/**
 * Relit le PDF archivé et revérifie son empreinte.
 *
 * Renvoie `null` quand le coffre n'est pas disponible — l'appelant retombe alors
 * sur un rendu depuis le payload figé, qui est déterministe. Un binaire altéré,
 * en revanche, n'est jamais servi : `readBlob` le refuse.
 */
export async function readArchivedOfDocument(pdfSha256: string): Promise<Buffer | null> {
  if (!isVaultConfigured()) return null;
  try {
    return await readBlob(storageKeyForSha256(pdfSha256), pdfSha256);
  } catch {
    // Absent du coffre : la réimpression se fera depuis le payload, puis sera
    // comparée à l'empreinte enregistrée. Un écart lèvera une erreur explicite.
    return null;
  }
}
