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
  repoAddVersion,
  repoCreateDocumentWithVersion,
  repoSetCurrentVersion,
  repoUpsertBlob,
} from "../../ged/repository/ged.repository";
import { isVaultConfigured, readBlob, storageKeyForSha256, writeBlob } from "../../ged/services/ged-vault.service";

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
};

/**
 * Verse le PDF au coffre et l'enregistre en GED, dans la transaction fournie.
 *
 * L'écriture du blob a lieu AVANT l'insertion : un enregistrement GED qui
 * pointerait vers un fichier absent serait pire qu'une absence d'archive, parce
 * qu'il affirmerait une conservation qui n'existe pas.
 */
export async function archiveOfDocument(
  tx: Pick<PoolClient, "query">,
  input: OfDocumentArchiveInput
): Promise<OfDocumentArchiveResult> {
  if (!isVaultConfigured()) {
    return {
      archived: false,
      gedDocumentId: null,
      gedVersionId: null,
      skippedReason:
        "Coffre documentaire non configuré : le document reste réimprimable depuis son payload figé et vérifié contre son empreinte.",
    };
  }

  const written = await writeBlob(input.pdf);
  if (written.sha256 !== input.pdfSha256) {
    // Ne peut arriver que si le binaire a changé entre le hachage et le dépôt.
    throw new Error(
      `Empreinte incohérente à l'archivage : attendue ${input.pdfSha256}, déposée ${written.sha256}.`
    );
  }

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
