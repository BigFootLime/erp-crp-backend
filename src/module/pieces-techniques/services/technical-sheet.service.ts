import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import {
  getOfficialDocumentGenerationEnvelope,
  readOfficialPdfBytes,
  recordOfficialPdfPrintIntent,
} from "../../../shared/authoritative-documents/authoritative-document.service";
import {
  repoQueueTechnicalSheet,
  repoTechnicalSheetSource,
} from "../repository/technical-sheet.repository";
import type { AuditContext } from "../repository/pieces-techniques.repository";

export const technicalSheetBaseUrl = (pieceId: string, versionId: string) =>
  `/pieces-techniques/${pieceId}/versions/${versionId}/technical-sheet`;
const scope = (pieceId: string, versionId: string) => ({
  entityType: "piece-technique-version",
  entityId: versionId,
  documentKind: "TECHNICAL_SHEET",
  baseUrl: technicalSheetBaseUrl(pieceId, versionId),
});

export async function assertTechnicalSheetReadable(
  pieceId: string,
  versionId: string,
) {
  const result = await pool.query(
    `SELECT 1 FROM public.piece_technique_versions v
    JOIN public.pieces_techniques p ON p.id=v.piece_technique_id
    WHERE p.id=$1::uuid AND v.id=$2::uuid AND p.deleted_at IS NULL`,
    [pieceId, versionId],
  );
  if (!result.rowCount)
    throw new HttpError(
      404,
      "NOT_FOUND",
      "Version technique introuvable pour cette pièce.",
    );
}
export async function getTechnicalSheetSource(
  pieceId: string,
  versionId: string,
) {
  return {
    source_revision: (await repoTechnicalSheetSource(pieceId, versionId))
      .sourceRevision,
  };
}
export const listTechnicalSheets = (pieceId: string, versionId: string) =>
  getOfficialDocumentGenerationEnvelope({
    tx: pool,
    ...scope(pieceId, versionId),
  });
export async function queueTechnicalSheet(
  pieceId: string,
  versionId: string,
  key: string,
  audit: AuditContext,
  input: { source_revision: string; reissue_reason?: string | null },
) {
  await repoQueueTechnicalSheet(pieceId, versionId, key, audit, input);
  return listTechnicalSheets(pieceId, versionId);
}
export const readTechnicalSheet = (
  pieceId: string,
  versionId: string,
  archiveId: string,
  actorUserId: number,
  eventType: "AUTHORITATIVE_PDF_PREVIEWED" | "AUTHORITATIVE_PDF_DOWNLOADED",
) =>
  readOfficialPdfBytes({
    ...scope(pieceId, versionId),
    archiveId,
    actorUserId,
    eventType,
  });
export const printTechnicalSheet = (
  pieceId: string,
  versionId: string,
  archiveId: string,
  actorUserId: number,
) =>
  recordOfficialPdfPrintIntent({
    ...scope(pieceId, versionId),
    archiveId,
    actorUserId,
  });
