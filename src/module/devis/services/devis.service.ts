import type {
  CreateDevisBodyDTO,
  ListDevisQueryDTO,
  UpdateDevisBodyDTO,
} from "../validators/devis.validators";
import type { UploadedDocument } from "../types/devis.types";
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
