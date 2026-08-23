import type {
  CreateDevisBodyDTO,
  ListDevisQueryDTO,
  UpdateDevisBodyDTO,
} from "../validators/devis.validators";
import type { UploadedDocument } from "../types/devis.types";
import pool from "../../../config/database";
import { getOfficialDocumentGenerationEnvelope, getOfficialPdfDto, readOfficialPdfBytes, recordOfficialPdfPrintIntent } from "../../../shared/authoritative-documents/authoritative-document.service";
import {
  repoConvertDevisToCommande,
  repoCreateDevis,
  repoDeleteDevis,
  repoFindDevisByArticle,
  repoFindDevisByArticleDevisCode,
  repoGetCommandeDraftFromDevis,
  repoGetDevis,
  repoGetDevisDocumentFileMeta,
  repoListDevis,
  repoListDevisVersions,
  repoReviseDevis,
  repoUpdateDevis,
  repoQueueDevisOfficialDocument,
  type DevisWriteContext,
} from "../repository/devis.repository";

export const svcListDevis = (filters: ListDevisQueryDTO) => repoListDevis(filters);

export const svcGetDevis = (id: number, include: string) => repoGetDevis(id, include);

export const svcListDevisVersions = (id: number) => repoListDevisVersions(id);

export const svcGetDevisDocumentFileMeta = (devisId: number, docId: string) =>
  repoGetDevisDocumentFileMeta(devisId, docId);

export const svcCreateDevis = (
  input: CreateDevisBodyDTO,
  userId: number,
  documents: UploadedDocument[],
  ctx: DevisWriteContext = {}
) => repoCreateDevis(input, userId, documents, ctx);

export const svcUpdateDevis = (
  id: number,
  input: UpdateDevisBodyDTO,
  userId: number,
  documents: UploadedDocument[],
  ctx: DevisWriteContext = {}
) => repoUpdateDevis(id, input, userId, documents, ctx);

export const svcReviseDevis = (
  id: number,
  input: UpdateDevisBodyDTO,
  userId: number,
  documents: UploadedDocument[],
  ctx: DevisWriteContext = {}
) => repoReviseDevis(id, input, userId, documents, ctx);

export const svcDeleteDevis = (id: number, ctx: DevisWriteContext = {}) => repoDeleteDevis(id, ctx);

export const svcGetCommandeDraftFromDevis = (id: number) => repoGetCommandeDraftFromDevis(id);

export const svcFindDevisByArticle = (articleId: string, limit: number) => repoFindDevisByArticle(articleId, limit);

export const svcFindDevisByArticleDevisCode = (code: string, limit: number) =>
  repoFindDevisByArticleDevisCode(code, limit);

export const svcConvertDevisToCommande = (
  id: number,
  opts: { expected_updated_at?: string } & DevisWriteContext = {}
) => repoConvertDevisToCommande(id, opts);

const devisOfficialBase = (id: number) => `/devis/${id}/official-documents`;
export const svcQueueDevisOfficialDocument = async (id: number, idempotencyKey: string, audit: NonNullable<DevisWriteContext["audit"]>, input: { source_revision: string; reissue_reason?: string | null }) => {
  await repoQueueDevisOfficialDocument(id, idempotencyKey, audit, input);
  return getOfficialDocumentGenerationEnvelope({ tx: pool, entityType: "devis", entityId: String(id), documentKind: "CUSTOMER_QUOTE", baseUrl: devisOfficialBase(id) });
};
export const svcListDevisOfficialDocuments = (id: number) =>
  getOfficialDocumentGenerationEnvelope({ tx: pool, entityType: "devis", entityId: String(id), documentKind: "CUSTOMER_QUOTE", baseUrl: devisOfficialBase(id) });
export const svcGetDevisOfficialDocument = (id: number, documentId: string) =>
  getOfficialPdfDto({ tx: pool, entityType: "devis", entityId: String(id), documentKind: "CUSTOMER_QUOTE", archiveId: documentId, baseUrl: devisOfficialBase(id) });
export const svcReadDevisOfficialDocument = (id: number, documentId: string, actorUserId: number, eventType: "AUTHORITATIVE_PDF_PREVIEWED" | "AUTHORITATIVE_PDF_DOWNLOADED") =>
  readOfficialPdfBytes({ entityType: "devis", entityId: String(id), documentKind: "CUSTOMER_QUOTE", archiveId: documentId, actorUserId, eventType });
export const svcRecordDevisOfficialPrint = (id: number, documentId: string, actorUserId: number) =>
  recordOfficialPdfPrintIntent({ entityType: "devis", entityId: String(id), documentKind: "CUSTOMER_QUOTE", archiveId: documentId, actorUserId });
