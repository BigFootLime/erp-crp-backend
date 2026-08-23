import db from "../../../config/database";
import {
  getOfficialDocumentGenerationEnvelope,
  readOfficialPdfBytes,
  recordOfficialPdfPrintIntent,
} from "../../../shared/authoritative-documents/authoritative-document.service";
import type { AuditContext } from "../repository/client.repository";
import { repoQueueClientProfileOfficialDocument } from "../repository/client.repository";

const baseUrl = (id: string) => `/clients/${encodeURIComponent(id)}/official-documents`;

export async function queueClientProfileDocument(
  id: string,
  idempotencyKey: string,
  audit: AuditContext,
  input: { source_revision: string; reissue_reason?: string | null }
) {
  await repoQueueClientProfileOfficialDocument(id, idempotencyKey, audit, input);
  return listClientProfileDocuments(id);
}

export const listClientProfileDocuments = (id: string) =>
  getOfficialDocumentGenerationEnvelope({
    tx: db, entityType: "client", entityId: id, documentKind: "CLIENT_PROFILE", baseUrl: baseUrl(id),
  });

export const readClientProfileDocument = (
  id: string,
  archiveId: string,
  actorUserId: number,
  eventType: "AUTHORITATIVE_PDF_PREVIEWED" | "AUTHORITATIVE_PDF_DOWNLOADED"
) => readOfficialPdfBytes({
  entityType: "client", entityId: id, documentKind: "CLIENT_PROFILE", archiveId, actorUserId, eventType,
});

export const recordClientProfilePrintIntent = (id: string, archiveId: string, actorUserId: number) =>
  recordOfficialPdfPrintIntent({
    entityType: "client", entityId: id, documentKind: "CLIENT_PROFILE", archiveId, actorUserId,
  });
