export { repoListLots, repoGetLot, repoCreateLot, repoUpdateLot, repoUpdateLotQuality, repoGetLotGenealogy, repoCreateLotGenealogy } from "./stock-lots.repository";
export {
  repoCancelMovement,
  repoCompensateMovement,
  repoPreviewMovement,
  repoPreviewMovementCompensation,
} from "./stock-movement-corrections.repository";
export type {
  StockOpeningReferenceInput,
  StockOpeningReferenceResolution,
} from "./stock-historical-openings.repository";
export {
  repoCreateHistoricalImport,
  repoCreateHistoricalImportTx,
  repoResolveStockOpeningReferences,
} from "./stock-historical-openings.repository";
export {
  repoAttachArticleDocuments,
  repoRemoveArticleDocument,
  repoGetArticleDocumentForDownload,
  repoListMovementDocuments,
  repoAttachMovementDocuments,
  repoRemoveMovementDocument,
  repoGetMovementDocumentForDownload,
} from "./stock-documents.repository";
import type { StockMovementDetail } from "../types/stock.types";
export {
  assertDirectOutMovementQualityEligibility,
  assertStockConsumptionAllowed,
  beginStockCommand,
  completeStockCommand,
  ensureStockBatchId,
  ensureStockLevel,
  getEmplacementMapping,
  insertAuditLog,
  isMaterialRemnantReversalTx,
  lockStockStates,
  repoCreateMovement,
  repoGetMovement,
  repoPostMovement,
  resolveUnitIdForArticle,
  stockTargetKey,
} from "./stock-movement-core.repository";
export type {
  AuditContext,
  BegunStockCommand,
  EmplacementMapping,
  LockedStockState,
  StockCommandReceipt,
  StockCommandType,
  StockLockTarget,
} from "./stock-movement-core.repository";

export {
  repoActivateMagasin,
  repoCreateEmplacement,
  repoCreateMagasin,
  repoDeactivateMagasin,
  repoGetMagasin,
  repoGetMagasinsKpis,
  repoListEmplacements,
  repoListMagasins,
  repoUpdateEmplacement,
  repoUpdateMagasin,
} from "./stock-locations.repository";


export {
  commandeClientSelectableCategoryCodes,
  normalizeArticleCategories,
  normalizeArticleCategorySelection,
  resolveMaterialCodeInput,
  repoPreviewMaterialArticleCode,
  repoListArticleCategories,
  repoListStockUnits,
  repoListArticleFamilies,
  repoCreateArticleFamily,
  repoUpdateArticleFamily,
  repoListMatiereNuances,
  repoCreateMatiereNuance,
  repoUpdateMatiereNuance,
  repoListMatiereEtats,
  repoCreateMatiereEtat,
  repoUpdateMatiereEtat,
  repoListMatiereSousEtats,
  repoCreateMatiereSousEtat,
  repoUpdateMatiereSousEtat,
} from "./stock-material-referentials.repository";
export type { MaterialCodePreview, MaterialCodeRequest } from "./stock-material-referentials.repository";

export {
  repoListInventorySessions,
  repoCreateInventorySession,
  repoStartInventorySession,
  repoGetInventorySession,
  repoListInventorySessionLines,
  repoUpsertInventoryLine,
  repoApproveInventorySession,
  repoCancelInventorySession,
  repoCloseInventorySession,
} from "./stock-inventory-sessions.repository";

export { repoListArticleDocuments } from "./stock-document-reads.repository";

export {
  assertCanonicalArticleUnit,
  syncArticleSubtypeDetails,
  repoListArticles,
  repoGetArticle,
  repoListAvailableArticleLots,
  repoGetArticlesKpis,
  queueStockArticleCreationSnapshotTx,
  repoCreateArticleTx,
  repoCreateArticle,
  repoUpdateArticle,
  repoValidateArticle,
  repoListArticleVersions,
  repoListArticleWhereUsed,
  repoArchiveArticle,
  repoReactivateArticle,
} from "./stock-article-lifecycle.repository";
export type { CreatedArticleSummary } from "./stock-article-lifecycle.repository";
export { repoListConsolidatedInventory, repoListBalances, repoGetStockAnalytics, repoListMovements } from "./stock-reporting.repository";

type MovementRow = StockMovementDetail["movement"];
