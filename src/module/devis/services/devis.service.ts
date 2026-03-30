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
  repoReviseDevis,
  repoUpdateDevis,
} from "../repository/devis.repository";

export const svcListDevis = (filters: ListDevisQueryDTO) => repoListDevis(filters);

export const svcGetDevis = (id: number, include: string) => repoGetDevis(id, include);

export const svcGetDevisDocumentFileMeta = (devisId: number, docId: string) =>
  repoGetDevisDocumentFileMeta(devisId, docId);

export const svcCreateDevis = (input: CreateDevisBodyDTO, userId: number, documents: UploadedDocument[]) =>
  repoCreateDevis(input, userId, documents);

export const svcUpdateDevis = (id: number, input: UpdateDevisBodyDTO, userId: number, documents: UploadedDocument[]) =>
  repoUpdateDevis(id, input, userId, documents);

export const svcReviseDevis = (id: number, input: UpdateDevisBodyDTO, userId: number, documents: UploadedDocument[]) =>
  repoReviseDevis(id, input, userId, documents);

export const svcDeleteDevis = (id: number) => repoDeleteDevis(id);

export const svcGetCommandeDraftFromDevis = (id: number) => repoGetCommandeDraftFromDevis(id);

export const svcFindDevisByArticle = (articleId: string, limit: number) => repoFindDevisByArticle(articleId, limit);

export const svcFindDevisByArticleDevisCode = (code: string, limit: number) =>
  repoFindDevisByArticleDevisCode(code, limit);

export const svcConvertDevisToCommande = (id: number) => repoConvertDevisToCommande(id);
