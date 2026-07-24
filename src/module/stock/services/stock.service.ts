import type {
  StockAnalytics,
  StockArticleCategoryOption,
  StockArticleDetail,
  StockArticleFamily,
  StockArticleKpis,
  StockBalanceRow,
  StockMatiereEtat,
  StockMatiereNuance,
  StockMatiereSousEtat,
  StockDocument,
  StockEmplacementListItem,
  StockInventorySessionDetail,
  StockInventorySessionLine,
  StockInventorySessionListItem,
  StockLotDetail,
  StockLotGenealogy,
  StockLotListItem,
  StockMagasinDetail,
  StockMagasinKpis,
  StockMagasinListItem,
  StockMovementDetail,
  StockMovementCompensationPreview,
  StockMovementImpactPreview,
  StockMovementListItem,
} from "../types/stock.types";
import type {
  CreateInventorySessionBodyDTO,
  CreateArticleBodyDTO,
  CreateArticleFamilyBodyDTO,
  CreateMatiereEtatBodyDTO,
  CreateMatiereNuanceBodyDTO,
  CreateMatiereSousEtatBodyDTO,
  CreateEmplacementBodyDTO,
  CreateLotBodyDTO,
  CreateMagasinBodyDTO,
  CreateMovementBodyDTO,
  CompensateMovementBodyDTO,
  PostMovementBodyDTO,
  ListAnalyticsQueryDTO,
  ListInventorySessionsQueryDTO,
  ListArticlesQueryDTO,
  ListArticleVersionsQueryDTO,
  ListArticleWhereUsedQueryDTO,
  ListArticleFamiliesQueryDTO,
  ListMatiereEtatsQueryDTO,
  ListMatiereNuancesQueryDTO,
  ListMatiereSousEtatsQueryDTO,
  ListBalancesQueryDTO,
  ListEmplacementsQueryDTO,
  ListLotsQueryDTO,
  ListMagasinsQueryDTO,
  ListMovementsQueryDTO,
  UpsertInventoryLineBodyDTO,
  InventorySessionActionBodyDTO,
  CancelInventorySessionBodyDTO,
  UpdateArticleBodyDTO,
  ArchiveArticleBodyDTO,
  ReactivateArticleBodyDTO,
  ArticleDocumentMetadataDTO,
  UpdateEmplacementBodyDTO,
  UpdateLotBodyDTO,
  UpdateLotQualityBodyDTO,
  CreateLotGenealogyBodyDTO,
  UpdateMagasinBodyDTO,
} from "../validators/stock.validators";
import type { AuditContext } from "../repository/stock.repository";
import {
  repoCloseInventorySession,
  repoStartInventorySession,
  repoApproveInventorySession,
  repoCancelInventorySession,
  repoCreateInventorySession,
  repoCreateArticleFamily,
  repoCreateMatiereEtat,
  repoCreateMatiereNuance,
  repoCreateMatiereSousEtat,
  repoAttachArticleDocuments,
  repoAttachMovementDocuments,
  repoCancelMovement,
  repoCreateArticle,
  repoCreateEmplacement,
  repoCreateLot,
  repoCreateMagasin,
  repoCreateMovement,
  repoPreviewMovement,
  repoCompensateMovement,
  repoPreviewMovementCompensation,
  repoGetInventorySession,
  repoGetStockAnalytics,
  repoGetArticle,
  repoListArticleCategories,
  repoListArticleFamilies,
  repoListMatiereEtats,
  repoListMatiereNuances,
  repoListMatiereSousEtats,
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
  repoListInventorySessions,
  repoListInventorySessionLines,
  repoListMovementDocuments,
  repoListMovements,
  repoPostMovement,
  repoRemoveArticleDocument,
  repoRemoveMovementDocument,
  repoUpsertInventoryLine,
  repoUpdateArticle,
  repoArchiveArticle,
  repoReactivateArticle,
  repoListArticleVersions,
  repoListArticleWhereUsed,
  repoUpdateEmplacement,
  repoUpdateLot,
  repoUpdateLotQuality,
  repoGetLotGenealogy,
  repoCreateLotGenealogy,
  repoUpdateMagasin,
  repoDeactivateMagasin,
  repoActivateMagasin,
} from "../repository/stock.repository";

export async function listStockInventorySessionsSVC(filters: ListInventorySessionsQueryDTO) {
  return repoListInventorySessions(filters);
}

export async function createStockInventorySessionSVC(
  body: CreateInventorySessionBodyDTO,
  audit: AuditContext,
  idempotencyKey: string
): Promise<StockInventorySessionListItem> {
  return repoCreateInventorySession(body, audit, idempotencyKey);
}

export async function getStockInventorySessionSVC(id: string): Promise<StockInventorySessionDetail | null> {
  return repoGetInventorySession(id);
}

export async function listStockInventorySessionLinesSVC(id: string): Promise<StockInventorySessionLine[] | null> {
  return repoListInventorySessionLines(id);
}

export async function upsertStockInventorySessionLineSVC(
  sessionId: string,
  body: UpsertInventoryLineBodyDTO,
  audit: AuditContext,
  idempotencyKey: string
): Promise<StockInventorySessionLine | null> {
  return repoUpsertInventoryLine(sessionId, body, audit, idempotencyKey);
}

export async function startStockInventorySessionSVC(
  id: string,
  body: InventorySessionActionBodyDTO,
  audit: AuditContext,
  idempotencyKey: string
): Promise<StockInventorySessionDetail | null> {
  return repoStartInventorySession(id, body, audit, idempotencyKey);
}

export async function approveStockInventorySessionSVC(
  id: string,
  body: InventorySessionActionBodyDTO,
  audit: AuditContext,
  idempotencyKey: string
): Promise<StockInventorySessionDetail | null> {
  return repoApproveInventorySession(id, body, audit, idempotencyKey);
}

export async function cancelStockInventorySessionSVC(
  id: string,
  body: CancelInventorySessionBodyDTO,
  audit: AuditContext,
  idempotencyKey: string
): Promise<StockInventorySessionDetail | null> {
  return repoCancelInventorySession(id, body, audit, idempotencyKey);
}

export async function closeStockInventorySessionSVC(
  id: string,
  body: InventorySessionActionBodyDTO,
  audit: AuditContext,
  idempotencyKey: string
): Promise<StockInventorySessionDetail | null> {
  return repoCloseInventorySession(id, body, audit, idempotencyKey);
}

export async function listStockArticlesSVC(filters: ListArticlesQueryDTO) {
  return repoListArticles(filters);
}

export async function getStockArticleSVC(id: string, includeCosts = false): Promise<StockArticleDetail | null> {
  return repoGetArticle(id, includeCosts);
}

export async function getStockArticlesKpisSVC(): Promise<StockArticleKpis> {
  return repoGetArticlesKpis();
}

export async function listStockArticleCategoriesSVC(): Promise<StockArticleCategoryOption[]> {
  return repoListArticleCategories();
}

export async function listStockArticleFamiliesSVC(filters: ListArticleFamiliesQueryDTO): Promise<StockArticleFamily[]> {
  return repoListArticleFamilies(filters);
}

export async function listStockMatiereNuancesSVC(filters: ListMatiereNuancesQueryDTO): Promise<StockMatiereNuance[]> {
  return repoListMatiereNuances(filters);
}

export async function createStockMatiereNuanceSVC(body: CreateMatiereNuanceBodyDTO, audit: AuditContext): Promise<StockMatiereNuance> {
  return repoCreateMatiereNuance(body, audit);
}

export async function listStockMatiereEtatsSVC(filters: ListMatiereEtatsQueryDTO): Promise<StockMatiereEtat[]> {
  return repoListMatiereEtats(filters);
}

export async function createStockMatiereEtatSVC(body: CreateMatiereEtatBodyDTO, audit: AuditContext): Promise<StockMatiereEtat> {
  return repoCreateMatiereEtat(body, audit);
}

export async function listStockMatiereSousEtatsSVC(filters: ListMatiereSousEtatsQueryDTO): Promise<StockMatiereSousEtat[]> {
  return repoListMatiereSousEtats(filters);
}

export async function createStockMatiereSousEtatSVC(body: CreateMatiereSousEtatBodyDTO, audit: AuditContext): Promise<StockMatiereSousEtat> {
  return repoCreateMatiereSousEtat(body, audit);
}

export async function createStockArticleFamilySVC(
  body: CreateArticleFamilyBodyDTO,
  audit: AuditContext
): Promise<StockArticleFamily> {
  return repoCreateArticleFamily(body, audit);
}

export async function createStockArticleSVC(
  body: CreateArticleBodyDTO,
  audit: AuditContext,
  idempotencyKey: string,
  includeCosts = false
): Promise<StockArticleDetail> {
  return repoCreateArticle(body, audit, idempotencyKey, includeCosts);
}

export async function updateStockArticleSVC(
  id: string,
  patch: UpdateArticleBodyDTO,
  audit: AuditContext,
  includeCosts = false
): Promise<StockArticleDetail | null> {
  return repoUpdateArticle(id, patch, audit, includeCosts);
}

export async function archiveStockArticleSVC(
  id: string,
  body: ArchiveArticleBodyDTO,
  audit: AuditContext,
  includeCosts = false
): Promise<StockArticleDetail | null> {
  return repoArchiveArticle(id, body, audit, includeCosts);
}

export async function reactivateStockArticleSVC(
  id: string,
  body: ReactivateArticleBodyDTO,
  audit: AuditContext,
  includeCosts = false
): Promise<StockArticleDetail | null> {
  return repoReactivateArticle(id, body, audit, includeCosts);
}

export async function listStockArticleVersionsSVC(id: string, filters: ListArticleVersionsQueryDTO) {
  return repoListArticleVersions(id, filters);
}

export async function listStockArticleWhereUsedSVC(id: string, filters: ListArticleWhereUsedQueryDTO) {
  return repoListArticleWhereUsed(id, filters);
}

export async function listStockMagasinsSVC(filters: ListMagasinsQueryDTO) {
  return repoListMagasins(filters);
}

export async function getStockMagasinSVC(id: string): Promise<StockMagasinDetail | null> {
  return repoGetMagasin(id);
}

export async function getStockMagasinsKpisSVC(): Promise<StockMagasinKpis> {
  return repoGetMagasinsKpis();
}

export async function createStockMagasinSVC(body: CreateMagasinBodyDTO, audit: AuditContext) {
  return repoCreateMagasin(body, audit);
}

export async function updateStockMagasinSVC(
  id: string,
  patch: UpdateMagasinBodyDTO,
  audit: AuditContext
): Promise<StockMagasinDetail["magasin"] | null> {
  return repoUpdateMagasin(id, patch, audit);
}

export async function deactivateStockMagasinSVC(id: string, audit: AuditContext): Promise<StockMagasinDetail["magasin"] | null> {
  return repoDeactivateMagasin(id, audit);
}

export async function activateStockMagasinSVC(id: string, audit: AuditContext): Promise<StockMagasinDetail["magasin"] | null> {
  return repoActivateMagasin(id, audit);
}

export async function listStockEmplacementsSVC(filters: ListEmplacementsQueryDTO) {
  return repoListEmplacements(filters);
}

export async function createStockEmplacementSVC(
  magasinId: string,
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

export async function getStockLotSVC(id: string): Promise<StockLotDetail | null> {
  return repoGetLot(id);
}

export async function createStockLotSVC(body: CreateLotBodyDTO, audit: AuditContext): Promise<StockLotDetail> {
  return repoCreateLot(body, audit);
}

export async function updateStockLotSVC(id: string, patch: UpdateLotBodyDTO, audit: AuditContext): Promise<StockLotDetail | null> {
  return repoUpdateLot(id, patch, audit);
}

export async function updateStockLotQualitySVC(
  id: string,
  body: UpdateLotQualityBodyDTO,
  audit: AuditContext,
  idempotencyKey: string
): Promise<StockLotDetail | null> {
  return repoUpdateLotQuality(id, body, audit, idempotencyKey);
}

export async function getStockLotGenealogySVC(id: string): Promise<StockLotGenealogy | null> {
  return repoGetLotGenealogy(id);
}

export async function createStockLotGenealogySVC(
  body: CreateLotGenealogyBodyDTO,
  audit: AuditContext,
  idempotencyKey: string
) {
  return repoCreateLotGenealogy(body, audit, idempotencyKey);
}

export async function listStockBalancesSVC(filters: ListBalancesQueryDTO) {
  return repoListBalances(filters);
}

export async function getStockAnalyticsSVC(filters: ListAnalyticsQueryDTO): Promise<StockAnalytics> {
  return repoGetStockAnalytics(filters);
}

export async function listStockMovementsSVC(filters: ListMovementsQueryDTO) {
  return repoListMovements(filters);
}

export async function getStockMovementSVC(id: string): Promise<StockMovementDetail | null> {
  return repoGetMovement(id);
}

export async function createStockMovementSVC(body: CreateMovementBodyDTO, audit: AuditContext): Promise<StockMovementDetail> {
  return repoCreateMovement(body, audit);
}

export async function previewStockMovementSVC(
  body: CreateMovementBodyDTO
): Promise<StockMovementImpactPreview> {
  return repoPreviewMovement(body);
}

export async function previewStockMovementCompensationSVC(
  id: string,
  body: CompensateMovementBodyDTO
): Promise<StockMovementCompensationPreview | null> {
  return repoPreviewMovementCompensation(id, body);
}

export async function compensateStockMovementSVC(
  id: string,
  body: CompensateMovementBodyDTO,
  audit: AuditContext,
  idempotencyKey: string
): Promise<StockMovementDetail | null> {
  return repoCompensateMovement(id, body, audit, idempotencyKey);
}

export async function postStockMovementSVC(
  id: string,
  body: PostMovementBodyDTO,
  audit: AuditContext,
  idempotencyKey: string
): Promise<StockMovementDetail | null> {
  return repoPostMovement(id, body, audit, idempotencyKey);
}

export async function cancelStockMovementSVC(
  id: string,
  audit: AuditContext,
  idempotencyKey: string
): Promise<StockMovementDetail | null> {
  return repoCancelMovement(id, audit, idempotencyKey);
}

export async function listStockArticleDocumentsSVC(articleId: string): Promise<StockDocument[] | null> {
  return repoListArticleDocuments(articleId);
}

export async function attachStockArticleDocumentsSVC(
  articleId: string,
  documents: Express.Multer.File[],
  metadata: ArticleDocumentMetadataDTO,
  audit: AuditContext
): Promise<StockDocument[] | null> {
  return repoAttachArticleDocuments(articleId, documents, metadata, audit);
}

export async function removeStockArticleDocumentSVC(
  articleId: string,
  documentId: string,
  audit: AuditContext
): Promise<boolean | null> {
  return repoRemoveArticleDocument(articleId, documentId, audit);
}

export async function getStockArticleDocumentForDownloadSVC(
  articleId: string,
  documentId: string,
  audit: AuditContext
) {
  return repoGetArticleDocumentForDownload(articleId, documentId, audit);
}

export async function listStockMovementDocumentsSVC(movementId: string): Promise<StockDocument[] | null> {
  return repoListMovementDocuments(movementId);
}

export async function attachStockMovementDocumentsSVC(
  movementId: string,
  documents: Express.Multer.File[],
  audit: AuditContext
): Promise<StockDocument[] | null> {
  return repoAttachMovementDocuments(movementId, documents, audit);
}

export async function removeStockMovementDocumentSVC(
  movementId: string,
  documentId: string,
  audit: AuditContext
): Promise<boolean | null> {
  return repoRemoveMovementDocument(movementId, documentId, audit);
}

export async function getStockMovementDocumentForDownloadSVC(
  movementId: string,
  documentId: string,
  audit: AuditContext
) {
  return repoGetMovementDocumentForDownload(movementId, documentId, audit);
}
