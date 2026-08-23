import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { getOfficialDocumentGenerationEnvelope, getOfficialPdfDto, readOfficialPdfBytes, recordOfficialPdfPrintIntent } from "../../../shared/authoritative-documents/authoritative-document.service";

type FinanceLegalKind = "FACTURE" | "AVOIR";

const config = (kind: FinanceLegalKind) => kind === "FACTURE"
  ? { table: "facture", entityType: "facture", documentKind: "FINANCE_INVOICE_LEGAL_PDF", base: "/factures" }
  : { table: "avoir", entityType: "avoir", documentKind: "FINANCE_CREDIT_NOTE_LEGAL_PDF", base: "/avoirs" };

async function entityUuid(kind: FinanceLegalKind, id: number): Promise<string> {
  const c = config(kind);
  const row = await pool.query<{ uuid: string; statut: string }>(`SELECT uuid::text, statut FROM public.${c.table} WHERE id = $1`, [id]);
  if (!row.rows[0]) throw new HttpError(404, "FINANCE_DOCUMENT_NOT_FOUND", "Document Finance introuvable.");
  if (row.rows[0].statut !== "ISSUED") throw new HttpError(409, "OFFICIAL_DOCUMENT_NOT_ISSUED", "Le document légal n'est pas encore émis.");
  return row.rows[0].uuid;
}

const baseUrl = (kind: FinanceLegalKind, id: number) => `${config(kind).base}/${id}/official-documents`;

export async function listFinanceLegalArchive(kind: FinanceLegalKind, id: number) {
  const entityId = await entityUuid(kind, id); const c = config(kind);
  return getOfficialDocumentGenerationEnvelope({ tx: pool, entityType: c.entityType, entityId, documentKind: c.documentKind, baseUrl: baseUrl(kind, id) });
}
export async function getFinanceLegalArchive(kind: FinanceLegalKind, id: number, archiveId: string) {
  const entityId = await entityUuid(kind, id); const c = config(kind);
  return getOfficialPdfDto({ tx: pool, entityType: c.entityType, entityId, documentKind: c.documentKind, archiveId, baseUrl: baseUrl(kind, id) });
}
export async function readFinanceLegalArchive(kind: FinanceLegalKind, id: number, archiveId: string, actorUserId: number, eventType: "AUTHORITATIVE_PDF_PREVIEWED" | "AUTHORITATIVE_PDF_DOWNLOADED") {
  const entityId = await entityUuid(kind, id); const c = config(kind);
  return readOfficialPdfBytes({ entityType: c.entityType, entityId, documentKind: c.documentKind, archiveId, actorUserId, eventType });
}
/** Legacy `/pdf` adapters use this only for an issued document: never regenerate legal bytes. */
export async function readLatestFinanceLegalArchive(kind: FinanceLegalKind, id: number, actorUserId: number, eventType: "AUTHORITATIVE_PDF_PREVIEWED" | "AUTHORITATIVE_PDF_DOWNLOADED") {
  const envelope = await listFinanceLegalArchive(kind, id);
  const archiveId = envelope.latest_document?.id;
  if (!archiveId) throw new HttpError(409, "OFFICIAL_DOCUMENT_NOT_READY", "Le document légal officiel est en cours d'archivage.");
  return readFinanceLegalArchive(kind, id, archiveId, actorUserId, eventType);
}
export async function printFinanceLegalArchive(kind: FinanceLegalKind, id: number, archiveId: string, actorUserId: number) {
  const entityId = await entityUuid(kind, id); const c = config(kind);
  return recordOfficialPdfPrintIntent({ entityType: c.entityType, entityId, documentKind: c.documentKind, archiveId, actorUserId });
}
