export { repoListLots, repoGetLot, repoCreateLot, repoUpdateLot, repoUpdateLotQuality, repoGetLotGenealogy, repoCreateLotGenealogy } from "./stock-lots.repository";
import { tableColumnExists } from "./stock-schema.repository";
import {
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
  assertConsistentLocations,
  assertSameArticle,
  assertSameLotIfSet,
  ensureArticleStockManaged,
  ensureLotTrackingRespected,
  insertMovementEvent,
  isPgUniqueViolation,
  reserveMovementNo,
  sumQty,
} from "./stock-movement-core.repository";
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
import { pieceClientCodeSql } from "./stock-article-projection";
import { stockLotTraceReferenceValuesSql } from "../../../shared/provenance/stock-lot-trace.sql";
import { consumableWithdrawalOwnsMovement } from "./consumable-movement-guard";
import { assemblyComponentWithdrawalOwnsMovement } from './assembly-component-movement-guard';
import {reconcileReleasedConsolidationLot} from '../../production/repository/production-receipts.repository';
import { lockStockLaneTopology } from './stock-lane-routing.repository';
import { previewMaterialBarCompensationTx } from './material-bar-compensation.repository';
import { readMaterialBarCountRequirementsTx } from './material-bar-count-read-model.repository';
import { prepareMaterialBarCountEntryTx, recordMaterialBarCountTx, prepareMaterialBarCountSessionTx,
  applyMaterialBarCountTx, loadMaterialBarCountLinesTx, readMaterialBarCountsTx } from './material-bar-count.repository';
import type { PoolClient } from "pg";
import { assertStockEntrySource } from "../domain/manual-entry-policy";
import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import db from "../../../config/database";
import {
  generateTransactionalBusinessCode,
  generatePieceTechniqueBusinessCode,
} from "../../../shared/codes/code-generator.service";
import { transferSecureUploadToDestination } from "../../../shared/uploads/secure-upload";
import { classifyUploadReconciliation, withUploadTransaction } from "../../../shared/uploads/upload-transaction";
import { ensureDocumentStoragePath } from "../../../utils/cerpStorage";
import { HttpError } from "../../../utils/httpError";
import {
  calculateStockAvailability,
  type StockLotQualityStatus,
} from "../domain/stock-availability";
import { hashStockCommand, normalizeIdempotencyKey } from "../domain/stock-command";
import {
  commandeArticleEligibleSql,
  commandeArticleIneligibilityCodeSql,
} from "../domain/commande-article-eligibility";
import type {
  Paginated,
  StockAnalytics,
  StockBalanceRow,
  StockDocument,
  StockInventorySessionDetail,
  StockInventorySessionLine,
  StockInventorySessionListItem,
  StockLotDetail,
  StockLotGenealogy,
  StockLotGenealogyEdge,
  StockLotListItem,
  StockMovementDetail,
  StockMovementCompensationPreview,
  StockMovementImpactPreview,
  StockMovementListItem,
  HistoricalStockImport,
  ConsolidatedInventoryRow,
} from "../types/stock.types";
import type {
  CreateInventorySessionBodyDTO,
  CreateLotBodyDTO,
  CreateMovementBodyDTO,
  CompensateMovementBodyDTO,
  CreateMovementLineDTO,
  ListAnalyticsQueryDTO,
  ListBalancesQueryDTO,
  ListInventorySessionsQueryDTO,
  ListLotsQueryDTO,
  ListMovementsQueryDTO,
  UpsertInventoryLineBodyDTO,
  InventorySessionActionBodyDTO,
  CancelInventorySessionBodyDTO,
  ArticleDocumentMetadataDTO,
  UpdateLotBodyDTO,
  UpdateLotQualityBodyDTO,
  CreateLotGenealogyBodyDTO,
  HistoricalImportBodyDTO,
  ListConsolidatedInventoryQueryDTO,
} from "../validators/stock.validators";
import { normalizeLikeQuery, sortDirection } from "./stock-query.repository";
import { defaultFamilyCodeForCategory, normalizeArticleCategorySelection, resolveMaterialCodeInput } from "./stock-material-referentials.repository";
import type {
  AuditContext,
  BegunStockCommand,
  EmplacementMapping,
  LockedStockState,
  StockCommandReceipt,
  StockCommandType,
  StockLockTarget,
} from "./stock-movement-core.repository";
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
import { normalizedArticleCategorySql, repoCreateArticleTx } from "./stock-article-lifecycle.repository";
import { repoListArticleDocuments } from "./stock-document-reads.repository";
import { oldMaterialDefinitionFromProjection, type OldMaterialDefinitionProjection } from "./stock-article-projection";
export { repoListConsolidatedInventory, repoListBalances, repoGetStockAnalytics, repoListMovements } from "./stock-reporting.repository";

type MovementRow = StockMovementDetail["movement"];
