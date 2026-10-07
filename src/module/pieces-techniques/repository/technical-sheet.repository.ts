import type { PoolClient } from "pg";
import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import {
  currentDocumentSource,
  queueCurrentDocument,
} from "../../../shared/authoritative-documents/current-document.repository";
import { buildTechnicalSheet } from "../domain/technical-sheet";
import { TECHNICAL_SHEET_SOURCE_SQL } from "./technical-sheet.sql";
import type { AuditContext } from "./pieces-techniques.repository";

export async function repoTechnicalSheetSource(
  pieceId: string,
  versionId: string,
  tx: Pick<PoolClient, "query"> = pool,
) {
  const result = await tx.query<{ source: unknown }>(
    TECHNICAL_SHEET_SOURCE_SQL,
    [pieceId, versionId],
  );
  if (!result.rows[0])
    throw new HttpError(
      404,
      "NOT_FOUND",
      "Version technique introuvable pour cette pièce.",
    );
  return currentDocumentSource(buildTechnicalSheet(result.rows[0].source));
}

export const repoQueueTechnicalSheet = (
  pieceId: string,
  versionId: string,
  idempotencyKey: string,
  audit: AuditContext,
  input: { source_revision: string; reissue_reason?: string | null },
) =>
  queueCurrentDocument({
    entityType: "piece-technique-version",
    entityId: versionId,
    documentKind: "TECHNICAL_SHEET",
    renderVersion: "technical-sheet-v1",
    title: "Fiche technique",
    filenamePrefix: "Fiche-technique",
    idempotencyKey,
    actorUserId: audit.user_id,
    input,
    loadSource: (tx) => repoTechnicalSheetSource(pieceId, versionId, tx),
    audit: async (tx, details) => {
      await repoInsertAuditLog({
        user_id: audit.user_id,
        ip: audit.ip,
        user_agent: audit.user_agent,
        device_type: audit.device_type,
        os: audit.os,
        browser: audit.browser,
        tx,
        body: {
          event_type: "ACTION",
          action: "TECHNICAL_SHEET_PDF_QUEUE",
          page_key: audit.page_key,
          path: audit.path,
          client_session_id: audit.client_session_id,
          entity_type: "piece_technique_version",
          entity_id: versionId,
          details: { piece_technique_id: pieceId, ...details },
        },
      });
    },
  });
