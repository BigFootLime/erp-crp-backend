import type {
  StockArticleDetail,
  StockArticleKpis,
  StockBalanceRow,
  StockDocument,
  StockEmplacementListItem,
  StockLotDetail,
  StockLotListItem,
  StockMagasinDetail,
  StockMagasinKpis,
  StockMagasinListItem,
  StockMovementDetail,
  StockMovementListItem,
} from "../types/stock.types";
import type {
  CreateArticleBodyDTO,
  CreateEmplacementBodyDTO,
  CreateLotBodyDTO,
  CreateMagasinBodyDTO,
  CreateMovementBodyDTO,
  ListArticlesQueryDTO,
  ListBalancesQueryDTO,
  ListEmplacementsQueryDTO,
  ListLotsQueryDTO,
  ListMagasinsQueryDTO,
  ListMovementsQueryDTO,
  UpdateArticleBodyDTO,
  UpdateEmplacementBodyDTO,
  UpdateLotBodyDTO,
  UpdateMagasinBodyDTO,
} from "../validators/stock.validators";
import type { AuditContext } from "../repository/stock.repository";
import {
  repoAttachArticleDocuments,
  repoAttachMovementDocuments,
  repoCancelMovement,
  repoCreateArticle,
  repoCreateEmplacement,
  repoCreateLot,
  repoCreateMagasin,
  repoCreateMovement,
  repoGetArticle,
  repoGetArticlesKpis,
  repoGetLot,
  repoGetMagasin,
  repoGetMagasinsKpis,
  repoGetMovement,
  repoGetArticleDocumentForDownload,
  repoGetMovementDocumentForDownload,
  repoListArticleDocuments,
  repoListArticles,
  repoListBalances,
  repoListEmplacements,
  repoListLots,
  repoListMagasins,
  repoListMovementDocuments,
  repoListMovements,
  repoPostMovement,
  repoRemoveArticleDocument,
  repoRemoveMovementDocument,
  repoUpdateArticle,
  repoUpdateEmplacement,
  repoUpdateLot,
  repoUpdateMagasin,
} from "../repository/stock.repository";

export async function listStockArticlesSVC(filters: ListArticlesQueryDTO) {
  return repoListArticles(filters);
}

export async function getStockArticleSVC(id: number): Promise<StockArticleDetail | null> {
  return repoGetArticle(id);
}

export async function getStockArticlesKpisSVC(): Promise<StockArticleKpis> {
  return repoGetArticlesKpis();
}

export async function createStockArticleSVC(body: CreateArticleBodyDTO, audit: AuditContext): Promise<StockArticleDetail> {
  return repoCreateArticle(body, audit);
}

export async function updateStockArticleSVC(
  id: number,
  patch: UpdateArticleBodyDTO,
  audit: AuditContext
): Promise<StockArticleDetail | null> {
  return repoUpdateArticle(id, patch, audit);
}

export async function listStockMagasinsSVC(filters: ListMagasinsQueryDTO) {
  return repoListMagasins(filters);
}

export async function getStockMagasinSVC(id: number): Promise<StockMagasinDetail | null> {
  return repoGetMagasin(id);
}

export async function getStockMagasinsKpisSVC(): Promise<StockMagasinKpis> {
  return repoGetMagasinsKpis();
}

export async function createStockMagasinSVC(body: CreateMagasinBodyDTO, audit: AuditContext) {
  return repoCreateMagasin(body, audit);
}

export async function updateStockMagasinSVC(
  id: number,
  patch: UpdateMagasinBodyDTO,
  audit: AuditContext
): Promise<StockMagasinDetail["magasin"] | null> {
  return repoUpdateMagasin(id, patch, audit);
}

export async function listStockEmplacementsSVC(filters: ListEmplacementsQueryDTO) {
  return repoListEmplacements(filters);
}

export async function createStockEmplacementSVC(
  magasinId: number,
  body: CreateEmplacementBodyDTO,
  audit: AuditContext
): Promise<StockEmplacementListItem | null> {
  return repoCreateEmplacement(magasinId, body, audit);
}

export async function updateStockEmplacementSVC(
  id: number,
  patch: UpdateEmplacementBodyDTO,
  audit: AuditContext
): Promise<StockEmplacementListItem | null> {
  return repoUpdateEmplacement(id, patch, audit);
}

export async function listStockLotsSVC(filters: ListLotsQueryDTO) {
  return repoListLots(filters);
}

export async function getStockLotSVC(id: number): Promise<StockLotDetail | null> {
  return repoGetLot(id);
}

export async function createStockLotSVC(body: CreateLotBodyDTO, audit: AuditContext): Promise<StockLotDetail> {
  return repoCreateLot(body, audit);
}

export async function updateStockLotSVC(id: number, patch: UpdateLotBodyDTO, audit: AuditContext): Promise<StockLotDetail | null> {
  return repoUpdateLot(id, patch, audit);
}

export async function listStockBalancesSVC(filters: ListBalancesQueryDTO) {
  return repoListBalances(filters);
}

export async function listStockMovementsSVC(filters: ListMovementsQueryDTO) {
  return repoListMovements(filters);
}

export async function getStockMovementSVC(id: number): Promise<StockMovementDetail | null> {
  return repoGetMovement(id);
}

export async function createStockMovementSVC(body: CreateMovementBodyDTO, audit: AuditContext): Promise<StockMovementDetail> {
  return repoCreateMovement(body, audit);
}

export async function postStockMovementSVC(id: number, audit: AuditContext): Promise<StockMovementDetail | null> {
  return repoPostMovement(id, audit);
}

export async function cancelStockMovementSVC(id: number, audit: AuditContext): Promise<StockMovementDetail | null> {
  return repoCancelMovement(id, audit);
}

export async function listStockArticleDocumentsSVC(articleId: number): Promise<StockDocument[] | null> {
  return repoListArticleDocuments(articleId);
}

export async function attachStockArticleDocumentsSVC(
  articleId: number,
  documents: Express.Multer.File[],
  audit: AuditContext
): Promise<StockDocument[] | null> {
  return repoAttachArticleDocuments(articleId, documents, audit);
}

export async function removeStockArticleDocumentSVC(
  articleId: number,
  documentId: string,
  audit: AuditContext
): Promise<boolean | null> {
  return repoRemoveArticleDocument(articleId, documentId, audit);
}

export async function getStockArticleDocumentForDownloadSVC(
  articleId: number,
  documentId: string,
  audit: AuditContext
) {
  return repoGetArticleDocumentForDownload(articleId, documentId, audit);
}

export async function listStockMovementDocumentsSVC(movementId: number): Promise<StockDocument[] | null> {
  return repoListMovementDocuments(movementId);
}

export async function attachStockMovementDocumentsSVC(
  movementId: number,
  documents: Express.Multer.File[],
  audit: AuditContext
): Promise<StockDocument[] | null> {
  return repoAttachMovementDocuments(movementId, documents, audit);
}

export async function removeStockMovementDocumentSVC(
  movementId: number,
  documentId: string,
  audit: AuditContext
): Promise<boolean | null> {
  return repoRemoveMovementDocument(movementId, documentId, audit);
}

export async function getStockMovementDocumentForDownloadSVC(
  movementId: number,
  documentId: string,
  audit: AuditContext
) {
  return repoGetMovementDocumentForDownload(movementId, documentId, audit);
}
