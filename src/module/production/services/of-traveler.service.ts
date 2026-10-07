import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import {
  getOfficialDocumentGenerationEnvelope,
  readOfficialPdfBytes,
  recordOfficialPdfPrintIntent,
} from "../../../shared/authoritative-documents/authoritative-document.service";
import {
  repoOfTravelerSource,
  repoQueueOfTraveler,
} from "../repository/of-traveler.repository";
import type { AuditContext } from "../repository/production.repository";

const scope = (ofId: number) => ({
  entityType: "ordre-fabrication",
  entityId: String(ofId),
  documentKind: "OF_TRAVELER",
  baseUrl: `/production/of-versioning/${ofId}/traveler`,
});
export async function assertOfTravelerReadable(ofId: number) {
  if (
    !(
      await pool.query("SELECT 1 FROM public.ordres_fabrication WHERE id=$1", [
        ofId,
      ])
    ).rowCount
  )
    throw new HttpError(
      404,
      "OF_NOT_FOUND",
      "Ordre de fabrication introuvable.",
    );
}
export async function getOfTravelerSource(ofId: number) {
  return { source_revision: (await repoOfTravelerSource(ofId)).sourceRevision };
}
export const listOfTravelers = (ofId: number) =>
  getOfficialDocumentGenerationEnvelope({ tx: pool, ...scope(ofId) });
export async function queueOfTraveler(
  ofId: number,
  key: string,
  audit: AuditContext,
  input: { source_revision: string; reissue_reason?: string | null },
) {
  await repoQueueOfTraveler(ofId, key, audit, input);
  return listOfTravelers(ofId);
}
export const readOfTraveler = (
  ofId: number,
  archiveId: string,
  actorUserId: number,
  eventType: "AUTHORITATIVE_PDF_PREVIEWED" | "AUTHORITATIVE_PDF_DOWNLOADED",
) =>
  readOfficialPdfBytes({ ...scope(ofId), archiveId, actorUserId, eventType });
export const printOfTraveler = (
  ofId: number,
  archiveId: string,
  actorUserId: number,
) => recordOfficialPdfPrintIntent({ ...scope(ofId), archiveId, actorUserId });
