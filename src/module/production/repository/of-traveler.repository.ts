import type { PoolClient } from "pg";
import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import {
  currentDocumentSource,
  queueCurrentDocument,
} from "../../../shared/authoritative-documents/current-document.repository";
import { buildOfTraveler } from "../domain/of-traveler";
import { OF_TRAVELER_SOURCE_SQL } from "./of-traveler.sql";
import type { AuditContext } from "./production.repository";

export async function repoOfTravelerSource(
  ofId: number,
  tx: Pick<PoolClient, "query"> = pool,
) {
  const result = await tx.query<{ source: unknown }>(OF_TRAVELER_SOURCE_SQL, [
    ofId,
  ]);
  if (!result.rows[0])
    throw new HttpError(
      404,
      "OF_NOT_FOUND",
      "Ordre de fabrication introuvable.",
    );
  return currentDocumentSource(buildOfTraveler(result.rows[0].source));
}
export const repoQueueOfTraveler = (
  ofId: number,
  key: string,
  audit: AuditContext,
  input: { source_revision: string; reissue_reason?: string | null },
) =>
  queueCurrentDocument({
    entityType: "ordre-fabrication",
    entityId: String(ofId),
    documentKind: "OF_TRAVELER",
    renderVersion: "of-traveler-v1",
    title: "Fiche suiveuse",
    filenamePrefix: "Fiche-suiveuse",
    idempotencyKey: key,
    actorUserId: audit.user_id,
    input,
    loadSource: (tx) => repoOfTravelerSource(ofId, tx),
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
          action: "OF_TRAVELER_PDF_QUEUE",
          page_key: audit.page_key,
          path: audit.path,
          client_session_id: audit.client_session_id,
          entity_type: "OF",
          entity_id: String(ofId),
          details,
        },
      });
    },
  });
