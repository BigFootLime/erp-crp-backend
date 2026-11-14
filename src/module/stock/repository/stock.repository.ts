import { pieceClientCodeSql } from "./stock-article-projection";
import { stockLotTraceReferenceValuesSql } from "../../../shared/provenance/stock-lot-trace.sql";
import { syncSubcontractDefinitionTx } from "./article-subcontract-definition.repository";
import { syncArticleSupplierConditionsTx } from "./article-supplier-conditions.repository";
import { consumableWithdrawalOwnsMovement } from "./consumable-movement-guard";
import { assemblyComponentWithdrawalOwnsMovement } from './assembly-component-movement-guard';
import { syncConsumablePolicyTx, consumablePolicyPatch } from "./consumable-article.repository";
import { syncArticleCommercialTx } from './article-commercial.repository';
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
import { nuanceIdentity, resolveNuanceIdentity, nuanceNormeFields } from "../domain/nuance-library";
import {
  generateArticleBusinessCode,
  generateFabricatedArticleBusinessCode,
  generateTransactionalBusinessCode,
  generatePieceTechniqueBusinessCode,
} from "../../../shared/codes/code-generator.service";
import { queueCreationPdfArchive } from "../../../shared/authoritative-documents/authoritative-document.service";
import { buildStockArticleCreationSnapshotInput } from "../../../shared/authoritative-documents/stock-article-creation-snapshot";
import {
  assertMaterialPreviewFresh,
  buildMaterialArticleCode,
  computeMaterialCodePreviewHash,
  isSpecialMaterialProfile,
  normalizeMaterialProfile,
  type MaterialCodeInput,
  type MaterialCodeResult,
  type MaterialProfileCode,
} from "../../../shared/codes/material-article-code";
import { canonicalizeStockUnitCode, materialManagementUnit } from "../../../shared/stock-unit";
import { findCanonicalStockUnit } from "../../../shared/stock-unit.repository";
import { transferSecureUploadToDestination } from "../../../shared/uploads/secure-upload";
import { classifyUploadReconciliation, withUploadTransaction } from "../../../shared/uploads/upload-transaction";
import { ensureDocumentStoragePath } from "../../../utils/cerpStorage";
import { HttpError } from "../../../utils/httpError";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import { calculateMargin } from "../../margin-engine/domain/margin-engine";
import {
  repoBuildCalculationInput,
  repoLoadScopeIdentity,
} from "../../margin-engine/repository/margin-engine.repository";
import {
  applyArticleSheetSalePriceTx,
  seedArticleSheetSalePriceTx,
} from "./article-sale-price.repository";
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
  ArticleCategory,
  ArticleBusinessCategory,
  ArticleTechnicalVersion,
  ArticleWorkflowStatus,
  ArticleWhereUsedItem,
  Paginated,
  StockAnalytics,
  StockArticleCategoryOption,
  StockArticleDetail,
  StockArticleFamily,
  StockArticleKpis,
  StockArticleListItem,
  StockAvailableLotItem,
  StockMatiereEtat,
  StockMatiereNuance,
  StockMatiereSousEtat,
  StockBalanceRow,
  StockDocument,
  StockEmplacementListItem,
  StockInventorySessionDetail,
  StockInventorySessionLine,
  StockInventorySessionListItem,
  StockLotDetail,
  StockLotGenealogy,
  StockLotGenealogyEdge,
  StockLotListItem,
  StockMagasinDetail,
  StockMagasinKpis,
  StockMagasinListItem,
  StockMovementDetail,
  StockMovementCompensationPreview,
  StockMovementImpactPreview,
  StockMovementEvent,
  StockMovementLineDetail,
  StockMovementListItem,
  HistoricalStockImport,
  ConsolidatedInventoryRow,
} from "../types/stock.types";
import type {
  ArticleCategoryDTO,
  CreateMatiereEtatBodyDTO,
  CreateMatiereNuanceBodyDTO,
  CreateMatiereSousEtatBodyDTO,
  UpdateMatiereNuanceBodyDTO,
  UpdateMatiereEtatBodyDTO,
  UpdateMatiereSousEtatBodyDTO,
  CreateArticleBodyDTO,
  CreateArticleFamilyBodyDTO,
  CreateEmplacementBodyDTO,
  CreateInventorySessionBodyDTO,
  CreateLotBodyDTO,
  CreateMagasinBodyDTO,
  CreateMovementBodyDTO,
  CompensateMovementBodyDTO,
  PostMovementBodyDTO,
  CreateMovementLineDTO,
  ListAnalyticsQueryDTO,
  ListArticlesQueryDTO,
  ListArticleFamiliesQueryDTO,
  ListMatiereEtatsQueryDTO,
  ListMatiereNuancesQueryDTO,
  ListMatiereSousEtatsQueryDTO,
  ListBalancesQueryDTO,
  ListEmplacementsQueryDTO,
  ListInventorySessionsQueryDTO,
  ListLotsQueryDTO,
  ListMagasinsQueryDTO,
  ListMovementsQueryDTO,
  StockMovementTypeDTO,
  UpsertInventoryLineBodyDTO,
  InventorySessionActionBodyDTO,
  CancelInventorySessionBodyDTO,
  UpdateArticleBodyDTO,
  ArchiveArticleBodyDTO,
  ReactivateArticleBodyDTO,
  ListArticleVersionsQueryDTO,
  ListArticleWhereUsedQueryDTO,
  ArticleDocumentMetadataDTO,
  UpdateEmplacementBodyDTO,
  UpdateLotBodyDTO,
  UpdateLotQualityBodyDTO,
  CreateLotGenealogyBodyDTO,
  UpdateMagasinBodyDTO,
  HistoricalImportBodyDTO,
  ListConsolidatedInventoryQueryDTO,
} from "../validators/stock.validators";

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
import { normalizeLikeQuery, sortDirection } from "./stock-query.repository";
import { articleFamilyTable, defaultFamilyCodeForCategory, materialFamilyCanonicalMap, normalizeArticleCategorySelection, normalizeFamilyCode, normalizeArticleWorkflowStatus, resolveArticleCode, resolveMaterialCodeInput, toBusinessArticleCategory, inferArticleType } from "./stock-material-referentials.repository";
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
export { oldMaterialDefinitionFromProjection, type OldMaterialDefinitionProjection } from "./stock-article-projection";

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
import { normalizedArticleCategorySql, repoCreateArticleTx, tableColumnExists } from "./stock-article-lifecycle.repository";
import { repoListArticleDocuments } from "./stock-document-reads.repository";
import { oldMaterialDefinitionFromProjection, type OldMaterialDefinitionProjection } from "./stock-article-projection";

export type StockOpeningReferenceInput = {
  key: string;
  article_id: string;
  magasin_code: string;
  emplacement_code: string;
};

export type StockOpeningReferenceResolution = {
  key: string;
  article_id: string;
  magasin_id: string | null;
  emplacement_id: number | null;
  issue: { code: string; message: string } | null;
};

type UploadedDocument = Express.Multer.File;

function safeDocExtension(originalName: string): string {
  const extCandidate = path.extname(originalName).toLowerCase();
  const safeExt = /^\.[a-z0-9]+$/.test(extCandidate) && extCandidate.length <= 10 ? extCandidate : "";
  return safeExt;
}

function toPosixPath(p: string): string {
  return p.split(path.sep).join(path.posix.sep);
}

async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function lotSortColumn(sortBy: ListLotsQueryDTO["sortBy"]): string {
  switch (sortBy) {
    case "created_at":
      return "l.created_at";
    case "lot_code":
      return "l.lot_code";
    case "received_at":
      return "l.received_at";
    case "updated_at":
    default:
      return "l.updated_at";
  }
}
export { repoListConsolidatedInventory, repoListBalances, repoGetStockAnalytics, repoListMovements } from "./stock-reporting.repository";



export async function repoResolveStockOpeningReferences(
  inputs: StockOpeningReferenceInput[]
): Promise<Map<string, StockOpeningReferenceResolution>> {
  if (inputs.length === 0) return new Map();

  const result = await db.query<{
    key: string;
    article_id: string;
    article_found: boolean;
    article_active: boolean | null;
    stock_managed: boolean | null;
    magasin_id: string | null;
    magasin_matches: number | string | null;
    magasin_active: boolean | null;
    emplacement_id: number | null;
    emplacement_matches: number | string | null;
    emplacement_active: boolean | null;
    allow_inbound: boolean | null;
    location_id: string | null;
    warehouse_id: string | null;
  }>(
    `
      WITH requested AS (
        SELECT
          item.key,
          item.article_id::uuid AS article_id,
          item.magasin_code,
          item.emplacement_code
        FROM jsonb_to_recordset($1::jsonb) AS item(
          key text,
          article_id text,
          magasin_code text,
          emplacement_code text
        )
      )
      SELECT
        requested.key,
        requested.article_id::text AS article_id,
        (article.id IS NOT NULL) AS article_found,
        article.is_active AS article_active,
        article.stock_managed,
        magasin.id::text AS magasin_id,
        COALESCE(magasin.matches, 0) AS magasin_matches,
        magasin.is_active AS magasin_active,
        emplacement.id::int AS emplacement_id,
        COALESCE(emplacement.matches, 0) AS emplacement_matches,
        emplacement.is_active AS emplacement_active,
        emplacement.allow_inbound,
        emplacement.location_id::text AS location_id,
        location.warehouse_id::text AS warehouse_id
      FROM requested
      LEFT JOIN public.articles article ON article.id = requested.article_id
      LEFT JOIN LATERAL (
        SELECT
          candidate.id,
          COALESCE(candidate.is_active, candidate.actif, false) AS is_active,
          count(*) OVER ()::int AS matches
        FROM public.magasins candidate
        WHERE upper(btrim(COALESCE(candidate.code, candidate.code_magasin))) =
              upper(btrim(requested.magasin_code))
        ORDER BY candidate.id
        LIMIT 1
      ) magasin ON true
      LEFT JOIN LATERAL (
        SELECT
          candidate.id,
          candidate.is_active,
          candidate.allow_inbound,
          candidate.location_id,
          count(*) OVER ()::int AS matches
        FROM public.emplacements candidate
        WHERE candidate.magasin_id = magasin.id
          AND upper(btrim(candidate.code)) = upper(btrim(requested.emplacement_code))
        ORDER BY candidate.id
        LIMIT 1
      ) emplacement ON true
      LEFT JOIN public.locations location ON location.id = emplacement.location_id
      ORDER BY requested.key
    `,
    [JSON.stringify(inputs)]
  );

  return new Map(result.rows.map((row) => {
    let issue: StockOpeningReferenceResolution["issue"] = null;
    const magasinMatches = Number(row.magasin_matches ?? 0);
    const emplacementMatches = Number(row.emplacement_matches ?? 0);

    if (!row.article_found) {
      issue = { code: "STOCK_ARTICLE_NOT_FOUND", message: "L’article CERP rapproché est introuvable." };
    } else if (!row.article_active) {
      issue = { code: "STOCK_ARTICLE_INACTIVE", message: "L’article CERP rapproché est inactif." };
    } else if (!row.stock_managed) {
      issue = { code: "STOCK_ARTICLE_NOT_MANAGED", message: "L’article CERP n’est pas géré en stock." };
    } else if (magasinMatches === 0) {
      issue = { code: "STOCK_MAGASIN_NOT_FOUND", message: "Le code magasin CERP est introuvable." };
    } else if (magasinMatches > 1) {
      issue = { code: "STOCK_MAGASIN_AMBIGUOUS", message: "Le code magasin CERP correspond à plusieurs magasins." };
    } else if (!row.magasin_active) {
      issue = { code: "STOCK_MAGASIN_INACTIVE", message: "Le magasin CERP est inactif." };
    } else if (emplacementMatches === 0) {
      issue = { code: "STOCK_EMPLACEMENT_NOT_FOUND", message: "Le code emplacement CERP est introuvable dans ce magasin." };
    } else if (emplacementMatches > 1) {
      issue = { code: "STOCK_EMPLACEMENT_AMBIGUOUS", message: "Le code emplacement CERP correspond à plusieurs emplacements." };
    } else if (!row.emplacement_active) {
      issue = { code: "STOCK_EMPLACEMENT_INACTIVE", message: "L’emplacement CERP est inactif." };
    } else if (!row.allow_inbound) {
      issue = { code: "STOCK_EMPLACEMENT_INBOUND_REFUSED", message: "L’emplacement CERP refuse les entrées de stock." };
    } else if (!row.location_id || !row.warehouse_id) {
      issue = { code: "STOCK_EMPLACEMENT_NOT_MAPPED", message: "L’emplacement CERP n’est pas relié au référentiel physique de stock." };
    }

    return [row.key, {
      key: row.key,
      article_id: row.article_id,
      magasin_id: row.magasin_id,
      emplacement_id: row.emplacement_id,
      issue,
    }];
  }));
}

export async function repoListLots(filters: ListLotsQueryDTO): Promise<Paginated<StockLotListItem>> {
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 50;
  const offset = (page - 1) * pageSize;

  const where: string[] = [];
  const values: unknown[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  if (filters.article_id) where.push(`l.article_id = ${push(filters.article_id)}::uuid`);
  if (filters.lot_status) where.push(`l.lot_status = ${push(filters.lot_status)}`);
  if (filters.q && filters.q.trim().length > 0) {
    const q = normalizeLikeQuery(filters.q);
    const p = push(q);
    where.push(
      `(
        l.lot_code ILIKE ${p}
        OR COALESCE(l.supplier_lot_code, '') ILIKE ${p}
        OR a.code ILIKE ${p}
        OR a.designation ILIKE ${p}
      )`
    );
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const orderBy = lotSortColumn(filters.sortBy);
  const orderDir = sortDirection(filters.sortDir);

  const countRes = await db.query<{ total: number }>(
    `SELECT COUNT(*)::int AS total FROM public.lots l JOIN public.articles a ON a.id = l.article_id ${whereSql}`,
    values
  );
  const total = countRes.rows[0]?.total ?? 0;

  const dataSql = `
    SELECT
      l.id::text AS id,
      l.article_id::text AS article_id,
      a.code AS article_code,
      a.designation AS article_designation,
      l.lot_code,
      l.lot_status,
      l.lot_status_note,
      l.supplier_lot_code,
      l.received_at::text AS received_at,
      l.manufactured_at::text AS manufactured_at,
      l.expiry_at::text AS expiry_at,
      NULLIF(to_jsonb(l) ->> 'quantite_lineaire_totale_mm', '')::float8 AS quantite_lineaire_totale_mm,
      l.updated_at::text AS updated_at,
      l.created_at::text AS created_at
    FROM public.lots l
    JOIN public.articles a ON a.id = l.article_id
    ${whereSql}
    ORDER BY ${orderBy} ${orderDir}
    LIMIT $${values.length + 1}
    OFFSET $${values.length + 2}
  `;

  const rows = await db.query<StockLotListItem>(dataSql, [...values, pageSize, offset]);
  return { items: rows.rows, total };
}

export async function repoGetLot(id: string): Promise<StockLotDetail | null> {
  const res = await db.query<StockLotDetail>(
    `
      SELECT
        l.id::text AS id,
        l.article_id::text AS article_id,
        a.code AS article_code,
        a.designation AS article_designation,
        a.unite AS unit_code,
        l.client_proprietaire_id::text AS client_proprietaire_id,
        c.company_name AS owner_client_name,
        COALESCE(l.material_properties, '{}'::jsonb) AS material_properties,
        (SELECT COALESCE(sum(b.qty_total),0)::float8 FROM public.stock_batches b WHERE b.lot_id=l.id) AS quantity_on_hand,
        (SELECT COALESCE(sum(b.qty_reserved),0)::float8 FROM public.stock_batches b WHERE b.lot_id=l.id) AS quantity_reserved,
        l.lot_code,
        l.lot_status,
        l.lot_status_note,
        l.supplier_lot_code,
        l.received_at::text AS received_at,
        l.manufactured_at::text AS manufactured_at,
        l.expiry_at::text AS expiry_at,
        NULLIF(to_jsonb(l) ->> 'quantite_lineaire_totale_mm', '')::float8 AS quantite_lineaire_totale_mm,
        l.notes,
        to_char(l.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at,
        l.created_at::text AS created_at
      FROM public.lots l
      JOIN public.articles a ON a.id = l.article_id
      LEFT JOIN public.clients c ON c.client_id = l.client_proprietaire_id
      WHERE l.id = $1::uuid
    `,
    [id]
  );
  return res.rows[0] ?? null;
}

export async function repoCreateLot(body: CreateLotBodyDTO, audit: AuditContext): Promise<StockLotDetail> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    if (body.lot_code?.trim()) {
      throw new HttpError(400, "LOT_CODE_SERVER_MANAGED", "Le numéro de lot interne est attribué automatiquement.");
    }
    const lotCode = await generateTransactionalBusinessCode(client, { prefix: "LOT" });
    const res = await client.query<{ id: string }>(
      `
        INSERT INTO public.lots (
          article_id, lot_code, supplier_lot_code,
          received_at, manufactured_at, expiry_at,
          notes, created_by, updated_by
        )
        VALUES ($1::uuid,$2,$3,$4::date,$5::date,$6::date,$7,$8,$8)
        RETURNING id::text AS id
      `,
      [
        body.article_id,
        lotCode,
        body.supplier_lot_code ?? null,
        body.received_at ?? null,
        body.manufactured_at ?? null,
        body.expiry_at ?? null,
        body.notes ?? null,
        audit.user_id,
      ]
    );
    const id = res.rows[0]?.id;
    if (!id) throw new Error("Failed to create lot");
    if (body.quantite_lineaire_totale_mm !== undefined) {
      if (!(await tableColumnExists(client, "lots", "quantite_lineaire_totale_mm"))) {
        throw new HttpError(
          503,
          "STOCK_SCHEMA_UPGRADE_REQUIRED",
          "Le patch additif #164 doit être appliqué avant d'enregistrer une quantité linéaire de lot."
        );
      }
      await client.query(
        `UPDATE public.lots
         SET quantite_lineaire_totale_mm = $2::numeric
         WHERE id = $1::uuid`,
        [id, body.quantite_lineaire_totale_mm ?? null]
      );
    }

    await insertAuditLog(client, audit, {
      action: "stock.lots.create",
      entity_type: "lots",
      entity_id: id,
      details: { article_id: body.article_id, lot_code: lotCode },
    });

    await client.query("COMMIT");

    const out = await repoGetLot(id);
    if (!out) throw new Error("Failed to read created lot");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (isPgUniqueViolation(err)) {
      throw new HttpError(409, "DUPLICATE", "Lot code already exists for this article");
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function repoUpdateLot(id: string, patch: UpdateLotBodyDTO, audit: AuditContext): Promise<StockLotDetail | null> {
  if (patch.lot_code !== undefined) {
    throw new HttpError(400, "LOT_CODE_IMMUTABLE", "Le numéro de lot interne ne peut pas être modifié.");
  }
  const sets: string[] = [];
  const values: unknown[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  if (patch.supplier_lot_code !== undefined) sets.push(`supplier_lot_code = ${push(patch.supplier_lot_code)}`);
  if (patch.received_at !== undefined) sets.push(`received_at = ${push(patch.received_at)}::date`);
  if (patch.manufactured_at !== undefined) sets.push(`manufactured_at = ${push(patch.manufactured_at)}::date`);
  if (patch.expiry_at !== undefined) sets.push(`expiry_at = ${push(patch.expiry_at)}::date`);
  if (patch.quantite_lineaire_totale_mm !== undefined) {
    if (!(await tableColumnExists(db, "lots", "quantite_lineaire_totale_mm"))) {
      throw new HttpError(
        503,
        "STOCK_SCHEMA_UPGRADE_REQUIRED",
        "Le patch additif #164 doit être appliqué avant d'enregistrer une quantité linéaire de lot."
      );
    }
    sets.push(`quantite_lineaire_totale_mm = ${push(patch.quantite_lineaire_totale_mm)}::numeric`);
  }
  if (patch.notes !== undefined) sets.push(`notes = ${push(patch.notes)}`);
  sets.push(`updated_at = now()`);
  sets.push(`updated_by = ${push(audit.user_id)}`);

  try {
    const res = await db.query<{ id: string }>(
      `UPDATE public.lots SET ${sets.join(", ")} WHERE id = ${push(id)}::uuid RETURNING id::text AS id`,
      values
    );
    if (!res.rows[0]?.id) return null;

    await insertAuditLog(db, audit, {
      action: "stock.lots.update",
      entity_type: "lots",
      entity_id: id,
      details: { patch },
    });

    return repoGetLot(id);
  } catch (err) {
    if (isPgUniqueViolation(err)) {
      throw new HttpError(409, "DUPLICATE", "Lot code already exists for this article");
    }
    throw err;
  }
}

export async function repoUpdateLotQuality(
  id: string,
  body: UpdateLotQualityBodyDTO,
  audit: AuditContext,
  idempotencyKey: string
): Promise<StockLotDetail | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await lockStockLaneTopology(client);
    const command = await beginStockCommand(client, {
      audit,
      idempotency_key: idempotencyKey,
      command_type: "LOT_QUALITY_CHANGE",
      request_payload: { lot_id: id, ...body },
    });
    if (command.existing) {
      await client.query("COMMIT");
      return repoGetLot(command.existing.resource_id);
    }

    const locked = await client.query<{
      lot_status: StockLotDetail["lot_status"];
      lot_status_note: string | null;
      updated_at: string;
    }>(
      `
        SELECT lot_status, lot_status_note, updated_at::text AS updated_at
        FROM public.lots
        WHERE id = $1::uuid
        FOR UPDATE
      `,
      [id]
    );
    const lot = locked.rows[0] ?? null;
    if (!lot) {
      await client.query("ROLLBACK");
      return null;
    }
    if (new Date(lot.updated_at).getTime() !== new Date(body.expected_updated_at).getTime()) {
      throw new HttpError(409, "CONCURRENT_MODIFICATION", "Lot quality status has changed");
    }
    if (lot.lot_status === body.lot_status) {
      throw new HttpError(409, "QUALITY_STATUS_UNCHANGED", "Lot already has this quality status");
    }

    if (body.lot_status === "LIBERE") {
      const openNc = await client.query<{ count: number }>(
        `
          SELECT COUNT(*)::int AS count
          FROM public.non_conformity
          WHERE lot_id = $1::uuid
            AND status::text <> 'CLOSED'
        `,
        [id]
      );
      if ((openNc.rows[0]?.count ?? 0) > 0) {
        throw new HttpError(
          409,
          "LOT_OPEN_NON_CONFORMITY",
          "Lot cannot be released while a non-conformity remains open"
        );
      }
    }

    await client.query(
      `
        UPDATE public.lots
        SET
          lot_status = $2,
          lot_status_note = $3,
          updated_at = now(),
          updated_by = $4
        WHERE id = $1::uuid
      `,
      [id, body.lot_status, body.reason, audit.user_id]
    );
    if(body.lot_status==='LIBERE')await reconcileReleasedConsolidationLot(client,id,audit.user_id);
    await client.query(
      `
        INSERT INTO public.stock_lot_event_log (
          lot_id,
          event_type,
          old_values,
          new_values,
          actor_user_id,
          correlation_id
        )
        VALUES (
          $1::uuid,
          'QUALITY_STATUS_CHANGED',
          $2::jsonb,
          $3::jsonb,
          $4,
          $5::uuid
        )
      `,
      [
        id,
        JSON.stringify({
          lot_status: lot.lot_status,
          lot_status_note: lot.lot_status_note,
          updated_at: lot.updated_at,
        }),
        JSON.stringify({ lot_status: body.lot_status, reason: body.reason }),
        audit.user_id,
        command.correlation_id,
      ]
    );
    await insertAuditLog(client, audit, {
      action: "stock.lots.quality_status.change",
      entity_type: "lots",
      entity_id: id,
      details: {
        before: { lot_status: lot.lot_status, lot_status_note: lot.lot_status_note },
        after: { lot_status: body.lot_status, lot_status_note: body.reason },
        correlation_id: command.correlation_id,
      },
    });
    await completeStockCommand(client, {
      audit,
      command,
      command_type: "LOT_QUALITY_CHANGE",
      resource_type: "stock_lot",
      resource_id: id,
      result_payload: { lot_id: id, lot_status: body.lot_status },
    });
    await client.query("COMMIT");
    return repoGetLot(id);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

const LOT_GENEALOGY_EDGE_SELECT = `
  SELECT
    edge.id::text AS id,
    edge.parent_lot_id::text AS parent_lot_id,
    parent_lot.lot_code AS parent_lot_code,
    parent_lot.article_id::text AS parent_article_id,
    parent_article.code AS parent_article_code,
    edge.child_lot_id::text AS child_lot_id,
    child_lot.lot_code AS child_lot_code,
    child_lot.article_id::text AS child_article_id,
    child_article.code AS child_article_code,
    edge.operation_type,
    edge.qty_contributed::float8 AS qty_contributed,
    edge.unit_code,
    edge.stock_movement_id::text AS stock_movement_id,
    edge.correlation_id::text AS correlation_id,
    edge.created_at::text AS created_at
  FROM genealogy edge
  JOIN public.lots parent_lot ON parent_lot.id = edge.parent_lot_id
  JOIN public.articles parent_article ON parent_article.id = parent_lot.article_id
  JOIN public.lots child_lot ON child_lot.id = edge.child_lot_id
  JOIN public.articles child_article ON child_article.id = child_lot.article_id
`;

export async function repoGetLotGenealogy(id: string): Promise<StockLotGenealogy | null> {
  const lot = await repoGetLot(id);
  if (!lot) return null;

  const ancestors = await db.query<StockLotGenealogyEdge>(
    `
      WITH RECURSIVE genealogy AS (
        SELECT edge.*
        FROM public.stock_lot_genealogy_edges edge
        WHERE edge.child_lot_id = $1::uuid
        UNION
        SELECT parent_edge.*
        FROM public.stock_lot_genealogy_edges parent_edge
        JOIN genealogy current_edge
          ON parent_edge.child_lot_id = current_edge.parent_lot_id
      )
      ${LOT_GENEALOGY_EDGE_SELECT}
      ORDER BY edge.created_at DESC, edge.id
    `,
    [id]
  );
  const descendants = await db.query<StockLotGenealogyEdge>(
    `
      WITH RECURSIVE genealogy AS (
        SELECT edge.*
        FROM public.stock_lot_genealogy_edges edge
        WHERE edge.parent_lot_id = $1::uuid
        UNION
        SELECT child_edge.*
        FROM public.stock_lot_genealogy_edges child_edge
        JOIN genealogy current_edge
          ON child_edge.parent_lot_id = current_edge.child_lot_id
      )
      ${LOT_GENEALOGY_EDGE_SELECT}
      ORDER BY edge.created_at ASC, edge.id
    `,
    [id]
  );
  return { lot, ancestors: ancestors.rows, descendants: descendants.rows };
}

export async function repoCreateLotGenealogy(
  body: CreateLotGenealogyBodyDTO,
  audit: AuditContext,
  idempotencyKey: string,
  transactionClient?: PoolClient
): Promise<{ correlation_id: string; edges: StockLotGenealogyEdge[] }> {
  const client = transactionClient ?? await db.connect();
  const ownsTransaction = !transactionClient;
  try {
    if (ownsTransaction) await client.query("BEGIN");
    const command = await beginStockCommand(client, {
      audit,
      idempotency_key: idempotencyKey,
      command_type: "LOT_GENEALOGY_RECORD",
      request_payload: body,
    });
    if (command.existing) {
      const edges = await client.query<StockLotGenealogyEdge>(
        `
          WITH genealogy AS (
            SELECT *
            FROM public.stock_lot_genealogy_edges
            WHERE correlation_id = $1::uuid
          )
          ${LOT_GENEALOGY_EDGE_SELECT}
          ORDER BY edge.created_at, edge.id
        `,
        [command.existing.correlation_id]
      );
      if (ownsTransaction) await client.query("COMMIT");
      return { correlation_id: command.existing.correlation_id, edges: edges.rows };
    }

    const movement = await client.query<{ id: string }>(
      `
        SELECT id::text AS id
        FROM public.stock_movements
        WHERE id = $1::uuid
          AND status::text = 'POSTED'
        FOR SHARE
      `,
      [body.stock_movement_id]
    );
    if (!movement.rows[0]?.id) {
      throw new HttpError(
        409,
        "POSTED_MOVEMENT_REQUIRED",
        "A posted stock movement is required for lot genealogy"
      );
    }

    const parentQty = body.parents.reduce((sum, item) => sum + item.qty, 0);
    const childQty = body.children.reduce((sum, item) => sum + item.qty, 0);
    if (Math.abs(parentQty - childQty) > 1e-6) {
      throw new HttpError(
        409,
        "GENEALOGY_QTY_MISMATCH",
        "Parent and child genealogy quantities must balance"
      );
    }

    const lotIds = [...body.parents, ...body.children].map((item) => item.lot_id).sort();
    for (const lotId of lotIds) {
      const lot = await client.query<{ id: string }>(
        `SELECT id::text AS id FROM public.lots WHERE id = $1::uuid FOR SHARE`,
        [lotId]
      );
      if (!lot.rows[0]?.id) throw new HttpError(400, "INVALID_LOT", "Unknown genealogy lot");
    }

    const contributions =
      body.operation_type === "SPLIT"
        ? body.children.map((child) => ({
            parent_lot_id: body.parents[0]!.lot_id,
            child_lot_id: child.lot_id,
            qty: child.qty,
          }))
        : body.operation_type === "MERGE"
          ? body.parents.map((parent) => ({
              parent_lot_id: parent.lot_id,
              child_lot_id: body.children[0]!.lot_id,
              qty: parent.qty,
            }))
          : [
              {
                parent_lot_id: body.parents[0]!.lot_id,
                child_lot_id: body.children[0]!.lot_id,
                qty: body.children[0]!.qty,
              },
            ];

    for (const contribution of contributions) {
      await client.query(
        `
          INSERT INTO public.stock_lot_genealogy_edges (
            parent_lot_id,
            child_lot_id,
            operation_type,
            qty_contributed,
            unit_code,
            stock_movement_id,
            correlation_id,
            created_by
          )
          VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6::uuid,$7::uuid,$8)
        `,
        [
          contribution.parent_lot_id,
          contribution.child_lot_id,
          body.operation_type,
          contribution.qty,
          body.unit_code,
          body.stock_movement_id,
          command.correlation_id,
          audit.user_id,
        ]
      );
    }

    const touchedLots = [...new Set(lotIds)];
    for (const lotId of touchedLots) {
      await client.query(
        `
          INSERT INTO public.stock_lot_event_log (
            lot_id,
            event_type,
            old_values,
            new_values,
            actor_user_id,
            correlation_id
          )
          VALUES ($1::uuid,'GENEALOGY_RECORDED',NULL,$2::jsonb,$3,$4::uuid)
        `,
        [
          lotId,
          JSON.stringify({
            operation_type: body.operation_type,
            stock_movement_id: body.stock_movement_id,
          }),
          audit.user_id,
          command.correlation_id,
        ]
      );
    }
    await completeStockCommand(client, {
      audit,
      command,
      command_type: "LOT_GENEALOGY_RECORD",
      resource_type: "stock_lot_genealogy",
      resource_id: command.correlation_id,
      result_payload: {
        correlation_id: command.correlation_id,
        edges_count: contributions.length,
      },
    });
    if (ownsTransaction) await client.query("COMMIT");

    const edges = await client.query<StockLotGenealogyEdge>(
      `
        WITH genealogy AS (
          SELECT *
          FROM public.stock_lot_genealogy_edges
          WHERE correlation_id = $1::uuid
        )
        ${LOT_GENEALOGY_EDGE_SELECT}
        ORDER BY edge.created_at, edge.id
      `,
      [command.correlation_id]
    );
    return { correlation_id: command.correlation_id, edges: edges.rows };
  } catch (error) {
    if (ownsTransaction) await client.query("ROLLBACK");
    throw error;
  } finally {
    if (ownsTransaction) client.release();
  }
}

async function ensureHistoricalPositionTx(client: PoolClient, kind: "PF" | "MP", shelf: string, audit: AuditContext) {
  const magasinCode = `OLD-${kind}`;
  const magasin = await client.query<{ id: string; warehouse_id: string | null; code: string }>(`SELECT id::text AS id, warehouse_id::text AS warehouse_id, COALESCE(code, code_magasin)::text AS code FROM public.magasins WHERE code = $1 FOR UPDATE`, [magasinCode]);
  const magasinId = magasin.rows[0]?.id;
  if (!magasinId) throw new HttpError(503, "STOCK_SCHEMA_UPGRADE_REQUIRED", "Les magasins OLD-PF et OLD-MP doivent être créés par le patch #446.");
  let emplacement = await client.query<{ id: number }>(`SELECT id::int AS id FROM public.emplacements WHERE magasin_id = $1::uuid AND code = $2 FOR UPDATE`, [magasinId, shelf]);
  let emplacementId = emplacement.rows[0]?.id;
  if (!emplacementId) {
    emplacement = await client.query<{ id: number }>(
      `INSERT INTO public.emplacements (magasin_id, code, name, is_scrap, is_active, location_type, allow_inbound, allow_outbound, restrictions, created_by, updated_by)
       VALUES ($1::uuid,$2,$2,false,true,'STORAGE',true,true,'{}'::jsonb,$3,$3) RETURNING id::int AS id`,
      [magasinId, shelf, audit.user_id]
    );
    emplacementId = emplacement.rows[0]?.id;
  }
  if (!emplacementId) throw new Error("Unable to create historical shelf");
  const warehouseId = magasin.rows[0]?.warehouse_id;
  if (!warehouseId) throw new HttpError(503, "STOCK_SCHEMA_UPGRADE_REQUIRED", "Le magasin OLD doit être lié à son entrepôt.");
  const locationCode = `${magasin.rows[0]?.code}-${shelf}`;
  let locationId = (await client.query<{ id: string }>(`SELECT id::text AS id FROM public.locations WHERE warehouse_id=$1::uuid AND code=$2 LIMIT 1`, [warehouseId, locationCode])).rows[0]?.id;
  if (!locationId) {
    locationId = (await client.query<{ id: string }>(`INSERT INTO public.locations (warehouse_id, code, description) VALUES ($1::uuid,$2,$3) RETURNING id::text AS id`, [warehouseId, locationCode, `Emplacement ${shelf}`])).rows[0]?.id;
  }
  if (!locationId) throw new Error("Unable to create historical stock location");
  await client.query(`UPDATE public.emplacements SET location_id=$2::uuid, updated_at=now(), updated_by=$3 WHERE id=$1::bigint AND location_id IS NULL`, [emplacementId, locationId, audit.user_id]);
  const map = await getEmplacementMapping(client, magasinId, emplacementId, "dst");
  return { magasinId, emplacementId, ...map };
}

/**
 * OLD recovery/import scaffolding is intentionally excluded from creation-PDF
 * automation: an import may materialize many historical technical roots, and
 * emitting a GED snapshot for each would create incidental mass archive output.
 */
async function ensureHistoricalPieceTechniqueTx(client: PoolClient, input: { clientNumber: string; reference: string; indice: string | null; designation: string }, audit: AuditContext) {
  const customer = await client.query<{ client_id: string; client_code: string; company_name: string | null }>(
    `SELECT client_id::text AS client_id, client_code, company_name FROM public.clients WHERE client_code = $1 OR client_id = $1 LIMIT 1 FOR UPDATE`, [input.clientNumber]
  );
  const c = customer.rows[0];
  if (!c) throw new HttpError(422, "CLIENT_NOT_FOUND", "Le numéro client doit correspondre à un client existant.");
  const indice = input.indice?.trim() || "NA";
  const code = await generatePieceTechniqueBusinessCode(client, { clientId: c.client_id, planReference: input.reference, indiceExterne: indice });
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`historical-pt:${code}`]);
  const existing = await client.query<{ id: string }>(`SELECT id::text AS id FROM public.pieces_techniques WHERE code_piece = $1 LIMIT 1`, [code]);
  if (existing.rows[0]?.id) return existing.rows[0].id;
  const id = crypto.randomUUID();
  await client.query(
    `INSERT INTO public.pieces_techniques (id, root_piece_technique_id, version_number, client_id, created_by, updated_by, famille_id, name_piece, code_piece, designation, prix_unitaire, statut, en_fabrication, code_client, client_name)
     VALUES ($1::uuid,$1::uuid,1,$2,$3,$3,NULL,$4,$5,$4,0,'DRAFT',false,$6,$7)`,
    [id, c.client_id, audit.user_id, input.designation, code, c.client_code, c.company_name]
  );
  await client.query(
    `INSERT INTO public.piece_technique_versions (piece_technique_id, indice, plan_reference, indice_externe_original, indice_externe_normalise, version_interne, code_metier, statut, is_current, raison_changement, motif_modification, created_by, updated_by)
     VALUES ($1::uuid,$2,$3,$4,$2,1,$5,'BROUILLON',false,'Reprise historique OLD','Reprise historique OLD',$6,$6)`,
    [id, indice, input.reference, input.indice ?? null, code, audit.user_id]
  );
  await client.query(`INSERT INTO public.pieces_techniques_historique (piece_technique_id, user_id, ancien_statut, nouveau_statut, commentaire) VALUES ($1::uuid,$2,NULL,'DRAFT','Création par reprise historique OLD')`, [id, audit.user_id]);
  return id;
}

/**
 * Creates one OLD opening movement in the caller's transaction.
 *
 * This is deliberately transaction-neutral: the cutover coordinator owns the
 * commit together with its crosswalk and audit records.  The public endpoint
 * continues to use {@link repoCreateHistoricalImport}, which owns its own
 * transaction.
 */
export async function repoCreateHistoricalImportTx(client: PoolClient, body: HistoricalImportBodyDTO, audit: AuditContext, idempotencyKey: string): Promise<HistoricalStockImport> {
    const command = await beginStockCommand(client, { audit, idempotency_key: idempotencyKey, command_type: "MOVEMENT_CREATE", request_payload: { historical_import: body } });
    if (command.existing) {
      const data = command.existing.result_payload as HistoricalStockImport | null;
      if (!data) throw new Error("Historical import receipt has no result");
      return { ...data, replayed: true };
    }
    let articleId: string;
    let shelf: string;
    if (body.kind === "MP") {
      if (body.article_id) articleId = body.article_id;
      else if (body.article) articleId = (await repoCreateArticleTx(client, body.article, audit)).id;
      else throw new HttpError(400, "ARTICLE_REQUIRED", "Article matière requis.");
      const a = await client.query<{ category: string; nuance: string | null }>(`SELECT a.article_category::text AS category, n.code AS nuance FROM public.articles a LEFT JOIN public.articles_matiere am ON am.article_id=a.id LEFT JOIN public.stock_nuances n ON n.id=am.nuance_id WHERE a.id=$1::uuid FOR UPDATE OF a`, [articleId]);
      if (a.rows[0]?.category !== "matiere") throw new HttpError(422, "MP_ARTICLE_REQUIRED", "L'import MP requiert un article matière première.");
      shelf = body.historical_shelf?.trim() || a.rows[0]?.nuance?.trim() || "SANS-NUANCE";
    } else {
      if (body.article_id) {
        const selected = await client.query<{ id: string; category: string; is_active: boolean; piece_technique_id: string | null; client_code: string | null }>(
          `SELECT a.id::text AS id, ${normalizedArticleCategorySql("a.article_category")} AS category,
                  a.is_active, a.piece_technique_id::text AS piece_technique_id, ${pieceClientCodeSql()} AS client_code
           FROM public.articles a
           LEFT JOIN public.pieces_techniques pt ON pt.id = a.piece_technique_id
           LEFT JOIN public.clients piece_client ON piece_client.client_id = pt.client_id
           WHERE a.id = $1::uuid
           FOR UPDATE OF a`,
          [body.article_id]
        );
        const article = selected.rows[0];
        if (!article) throw new HttpError(422, "PF_ARTICLE_NOT_FOUND", "L'article PF sélectionné est introuvable.");
        if (article.category !== "fabrique" || !article.piece_technique_id) {
          throw new HttpError(422, "PF_ARTICLE_REQUIRED", "La reprise PF requiert un article fabriqué relié à une pièce technique.");
        }
        if (!article.is_active) throw new HttpError(422, "PF_ARTICLE_INACTIVE", "L'article PF sélectionné est inactif.");
        if ((article.client_code ?? "").trim().toLowerCase() !== body.client_number.trim().toLowerCase()) {
          throw new HttpError(422, "PF_ARTICLE_CLIENT_MISMATCH", "L'article PF sélectionné n'appartient pas au client indiqué.");
        }
        articleId = article.id;
      } else {
        if (!body.reference || !body.designation) throw new HttpError(400, "PF_ARTICLE_DETAILS_REQUIRED", "Référence et désignation PF requises.");
        const ptId = await ensureHistoricalPieceTechniqueTx(client, { clientNumber: body.client_number, reference: body.reference, indice: body.indice ?? null, designation: body.designation }, audit);
        const existing = await client.query<{ id: string }>(`SELECT id::text AS id FROM public.articles WHERE piece_technique_id=$1::uuid LIMIT 1 FOR UPDATE`, [ptId]);
        if (existing.rows[0]?.id) articleId = existing.rows[0].id;
        else {
          const family = body.family_code ?? defaultFamilyCodeForCategory("fabrique");
          const historicalClient = (await client.query<{client_id:string}>("SELECT client_id FROM public.pieces_techniques WHERE id=$1::uuid",[ptId])).rows[0]?.client_id;
          if(!historicalClient)throw new HttpError(422,"ARTICLE_CLIENT_REQUIRED","La reprise doit identifier le client de cet article fini.");
          articleId = (await repoCreateArticleTx(client, { designation: body.designation, article_type: "PIECE_TECHNIQUE", article_category: "fabrique", article_categories: ["piece_finie_fabriquee"], commercial_scope:"CLIENTS", client_ids:[historicalClient], family_code: family, piece_technique_id: ptId, stock_managed: true, lot_tracking: true, is_sold: true, is_active: true, status: "VALIDE" }, audit)).id;
        }
      }
      shelf = body.historical_shelf?.trim() || body.client_number.trim();
    }
    await ensureArticleStockManaged(client, articleId);
    let historicalTechnicalVersionId: string | null = null;
    if (body.kind === "PF" && body.technical_version_id) {
      const selectedVersion = await client.query<{ id: string }>(
        `SELECT version.id::text AS id
         FROM public.articles article
         JOIN public.piece_technique_versions version
           ON version.piece_technique_id = article.piece_technique_id
         WHERE article.id = $1::uuid AND version.id = $2::uuid
         FOR SHARE OF article, version`,
        [articleId, body.technical_version_id]
      );
      if (!selectedVersion.rows[0]?.id) {
        throw new HttpError(422, "PF_TECHNICAL_VERSION_MISMATCH", "La version technique sélectionnée ne correspond pas à l'article fini.");
      }
      historicalTechnicalVersionId = selectedVersion.rows[0].id;
    } else if (body.kind === "PF") {
      historicalTechnicalVersionId = (await client.query<{ id: string }>(
          `SELECT version.id::text AS id
           FROM public.articles article
           JOIN public.piece_technique_versions version
             ON version.piece_technique_id = article.piece_technique_id
           WHERE article.id = $1::uuid
           ORDER BY
             (version.statut = 'APPLICABLE') DESC,
             version.is_current DESC,
             version.version_interne DESC,
             version.created_at DESC
           LIMIT 1`,
          [articleId]
        )).rows[0]?.id ?? null;
    }
    const position = await ensureHistoricalPositionTx(client, body.kind, shelf, audit);
    const lotCode = await generateTransactionalBusinessCode(client, { prefix: "LOT" });
    const traceSequence = await client.query<{ value: string }>(`SELECT nextval('public.stock_trace_code_446_seq')::text AS value`);
    const trace = (traceSequence.rows[0]?.value ?? "0").padStart(6, "0");
    const lot = await client.query<{ id: string }>(`INSERT INTO public.lots (article_id, lot_code, supplier_lot_code, notes, material_properties, stock_trace_code, qr_payload, origin_stock_scope, source_scope, stock_scope, lot_status, piece_technique_version_id, client_proprietaire_id, created_by, updated_by) VALUES ($1::uuid,$2,$3,$4,$5::jsonb,$6,$7,'OLD','OLD','OLD',$8,$9::uuid,$10::varchar,$11,$11) RETURNING id::text AS id`, [articleId, lotCode, body.supplier_lot_code ?? (body.kind === "MP" ? body.lot_number : null), body.notes ?? null, JSON.stringify(body.historical_traceability ?? {}), trace, `CERP-STOCK:${trace}`, body.historical_lot_status ?? "EN_ATTENTE", historicalTechnicalVersionId, body.owner_client_id ?? null, audit.user_id]);
    const lotId = lot.rows[0]?.id;
    if (!lotId) throw new Error("Unable to create historical lot");
    const refs: Array<["OF" | "MP_LOT" | "TRAITEMENT_LOT", string[]]> = body.kind === "PF"
      ? [["OF", body.of_affaire_refs], ["MP_LOT", body.mp_lot_refs], ["TRAITEMENT_LOT", body.traitement_lot_refs]]
      : [["MP_LOT", [body.lot_number]]];
    for (const [type, values] of refs) for (const value of values) await client.query(`INSERT INTO public.stock_lot_trace_references (lot_id, reference_type, reference_value, created_by) VALUES ($1::uuid,$2,$3,$4) ON CONFLICT DO NOTHING`, [lotId, type, value, audit.user_id]);
    if (body.historical_lot_reference) await client.query(`INSERT INTO public.stock_lot_trace_references (lot_id, reference_type, reference_value, created_by) VALUES ($1::uuid,'HISTORICAL_LOT',$2,$3) ON CONFLICT DO NOTHING`, [lotId, body.historical_lot_reference, audit.user_id]);
    const suppliedUnit = body.unite ?? null;
    const unitId = await resolveUnitIdForArticle(client, articleId, suppliedUnit);
    if (body.kind === "PF" && suppliedUnit) {
      const articleUnitId = await resolveUnitIdForArticle(client, articleId, null);
      if (unitId !== articleUnitId) {
        throw new HttpError(422, "PF_ARTICLE_UNIT_MISMATCH", "L'unité du stock historique ne correspond pas à l'unité de l'article fini.");
      }
    }
    const levelId = await ensureStockLevel(client, { article_id: articleId, unit_id: unitId, warehouse_id: position.warehouse_id, location_id: position.location_id, actor_user_id: audit.user_id });
    const batchId = await ensureStockBatchId(client, { stock_level_id: levelId, lot_id: lotId });
    const movementNo = await reserveMovementNo(client);
    const movement = await client.query<{ id: string }>(`INSERT INTO public.stock_movements (movement_no,movement_type,status,article_id,stock_level_id,stock_batch_id,qty,currency,effective_at,posted_at,posted_by,source_document_type,reason_code,notes,correlation_id,user_id,created_by,updated_by) VALUES ($1,'IN','POSTED',$2::uuid,$3::uuid,$4::uuid,$5,'EUR',now(),now(),$6,'CERP_HISTORICAL_OPENING','HISTORICAL_OPENING',$7,$8::uuid,$6,$6,$6) RETURNING id::text AS id`, [movementNo, articleId, levelId, batchId, body.quantity, audit.user_id, body.notes ?? null, command.correlation_id]);
    const movementId = movement.rows[0]?.id;
    if (!movementId) throw new Error("Unable to post historical opening movement");
    await client.query(`INSERT INTO public.stock_movement_lines (movement_id,line_no,article_id,lot_id,qty,unite,dst_magasin_id,dst_emplacement_id,created_by,updated_by) VALUES ($1::uuid,1,$2::uuid,$3::uuid,$4,$5,$6::uuid,$7::bigint,$8,$8)`, [movementId, articleId, lotId, body.quantity, body.unite ?? null, position.magasinId, position.emplacementId, audit.user_id]);
    await insertMovementEvent(client, { movement_id: movementId, event_type: "CREATED_POSTED", old_values: null, new_values: { status: "POSTED", source: "CERP_HISTORICAL_OPENING" }, user_id: audit.user_id });
    const result: HistoricalStockImport = { article_id: articleId, lot_id: lotId, lot_code: lotCode, movement_id: movementId, stock_trace_code: trace, qr_payload: `CERP-STOCK:${trace}`, replayed: false };
    await insertAuditLog(client, audit, { action: "stock.historical-import.create", entity_type: "stock_movements", entity_id: movementId, details: { kind: body.kind, article_id: articleId, lot_id: lotId, stock_scope: "OLD" } });
    await completeStockCommand(client, { audit, command, command_type: "MOVEMENT_CREATE", resource_type: "stock_movement", resource_id: movementId, result_payload: result });
    return result;
}

/** Endpoint-safe wrapper retaining the established standalone transaction. */
export async function repoCreateHistoricalImport(body: HistoricalImportBodyDTO, audit: AuditContext, idempotencyKey: string): Promise<HistoricalStockImport> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await repoCreateHistoricalImportTx(client, body, audit, idempotencyKey);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

type MovementRow = StockMovementDetail["movement"];

export async function repoPreviewMovement(
  body: CreateMovementBodyDTO
): Promise<StockMovementImpactPreview> {
  assertStockEntrySource({ movementType: body.movement_type });
  assertSameArticle(body.lines);
  assertConsistentLocations(body.lines, body.movement_type);
  if (body.movement_type === "RESERVE" || body.movement_type === "UNRESERVE") {
    throw new HttpError(
      422,
      "USE_RESERVATION_API",
      "Reservations are non-physical allocations and must use the stock reservation API"
    );
  }

  const articleId = body.lines[0]?.article_id;
  const first = body.lines[0];
  if (!articleId || !first) throw new HttpError(400, "INVALID_MOVEMENT", "Missing movement lines");
  await ensureArticleStockManaged(db, articleId);
  await ensureLotTrackingRespected(db, articleId, body.lines);
  const lotId = assertSameLotIfSet(body.lines);
  const totalQty = sumQty(body.lines);
  if (!Number.isFinite(totalQty) || totalQty <= 0) {
    throw new HttpError(400, "INVALID_MOVEMENT", "Movement quantity must be positive");
  }

  let lotStatus: StockLotQualityStatus = null;
  if (lotId) {
    const lot = await db.query<{ lot_status: StockLotQualityStatus }>(
      `
        SELECT lot_status
        FROM public.lots
        WHERE id = $1::uuid
          AND article_id = $2::uuid
      `,
      [lotId, articleId]
    );
    const row = lot.rows[0] ?? null;
    if (!row) throw new HttpError(409, "LOT_ARTICLE_MISMATCH", "Lot does not belong to article");
    lotStatus = row.lot_status ?? "LIBERE";
  }

  const readState = async (locationId: string): Promise<LockedStockState> => {
    const state = await db.query<{
      stock_level_id: string;
      stock_batch_id: string | null;
      qty_on_hand: number;
      qty_reserved: number;
      qty_depreciated: number;
      lot_status: StockLotQualityStatus;
    }>(
      `
        SELECT
          stock_level_id::text AS stock_level_id,
          stock_batch_id::text AS stock_batch_id,
          qty_on_hand::float8 AS qty_on_hand,
          qty_reserved::float8 AS qty_reserved,
          qty_depreciated::float8 AS qty_depreciated,
          lot_status
        FROM public.v_stock_availability_225
        WHERE article_id = $1::uuid
          AND location_id = $2::uuid
          AND lot_id IS NOT DISTINCT FROM $3::uuid
        LIMIT 1
      `,
      [articleId, locationId, lotId]
    );
    return (
      state.rows[0] ?? {
        stock_level_id: "00000000-0000-0000-0000-000000000000",
        stock_batch_id: null,
        qty_on_hand: 0,
        qty_reserved: 0,
        qty_depreciated: 0,
        lot_status: lotStatus,
      }
    );
  };

  const impacts: StockMovementImpactPreview["impacts"] = [];
  const blockers: StockMovementImpactPreview["blockers"] = [];
  const addImpact = async (
    side: "SOURCE" | "DESTINATION",
    magasinId: string,
    emplacementId: number,
    effect:
      | "IN"
      | "OUT"
      | "DEPRECIATE"
      | "ADJUSTMENT_IN"
      | "ADJUSTMENT_OUT"
  ) => {
    const mapping = await getEmplacementMapping(
      db,
      magasinId,
      emplacementId,
      side === "SOURCE" ? "src" : "dst"
    );
    const state = await readState(mapping.location_id);
    const before = calculateStockAvailability(state);
    if (side === "SOURCE") {
      try {
        assertStockConsumptionAllowed(state, {
          movement_type: body.movement_type,
          qty: effect === "ADJUSTMENT_OUT" ? -totalQty : totalQty,
        });
      } catch (error) {
        if (error instanceof HttpError) {
          blockers.push({ code: error.code, message: error.message });
        } else {
          throw error;
        }
      }
    }

    const afterInput = {
      qty_on_hand: state.qty_on_hand,
      qty_reserved: state.qty_reserved,
      qty_depreciated: state.qty_depreciated,
      lot_status: state.lot_status,
    };
    if (effect === "IN" || effect === "ADJUSTMENT_IN") {
      afterInput.qty_on_hand += totalQty;
    } else if (effect === "OUT" || effect === "ADJUSTMENT_OUT") {
      afterInput.qty_on_hand -= totalQty;
    } else if (effect === "DEPRECIATE") {
      afterInput.qty_depreciated += totalQty;
    }

    impacts.push({
      side,
      magasin_id: magasinId,
      emplacement_id: emplacementId,
      lot_id: lotId,
      before,
      after: calculateStockAvailability(afterInput),
    });
  };

  if (body.movement_type === "IN") {
    if (!first.dst_magasin_id || !first.dst_emplacement_id) {
      throw new HttpError(400, "INVALID_MOVEMENT", "IN requires destination location");
    }
    await addImpact("DESTINATION", first.dst_magasin_id, first.dst_emplacement_id, "IN");
  } else if (body.movement_type === "TRANSFER") {
    if (
      !first.src_magasin_id ||
      !first.src_emplacement_id ||
      !first.dst_magasin_id ||
      !first.dst_emplacement_id
    ) {
      throw new HttpError(400, "INVALID_MOVEMENT", "TRANSFER requires source and destination");
    }
    await addImpact("SOURCE", first.src_magasin_id, first.src_emplacement_id, "OUT");
    await addImpact("DESTINATION", first.dst_magasin_id, first.dst_emplacement_id, "IN");
  } else if (body.movement_type === "ADJUST" || body.movement_type === "ADJUSTMENT") {
    if (first.direction === "IN") {
      if (!first.dst_magasin_id || !first.dst_emplacement_id) {
        throw new HttpError(400, "INVALID_MOVEMENT", "ADJUSTMENT IN requires destination");
      }
      await addImpact(
        "DESTINATION",
        first.dst_magasin_id,
        first.dst_emplacement_id,
        "ADJUSTMENT_IN"
      );
    } else {
      if (!first.src_magasin_id || !first.src_emplacement_id) {
        throw new HttpError(400, "INVALID_MOVEMENT", "ADJUSTMENT OUT requires source");
      }
      await addImpact("SOURCE", first.src_magasin_id, first.src_emplacement_id, "ADJUSTMENT_OUT");
    }
  } else {
    if (!first.src_magasin_id || !first.src_emplacement_id) {
      throw new HttpError(400, "INVALID_MOVEMENT", `${body.movement_type} requires source`);
    }
    await addImpact(
      "SOURCE",
      first.src_magasin_id,
      first.src_emplacement_id,
      body.movement_type === "DEPRECIATE" || body.movement_type === "SCRAP"
        ? "DEPRECIATE"
        : "OUT"
    );
  }

  return {
    authoritative: true,
    as_of: new Date().toISOString(),
    movement_type: body.movement_type,
    qty_total: totalQty,
    can_post: blockers.length === 0,
    blockers,
    impacts,
  };
}

function buildCompensatingMovementBody(
  detail: StockMovementDetail,
  body: CompensateMovementBodyDTO
): {
  movement: CreateMovementBodyDTO | null;
  blockers: Array<{ code: string; message: string }>;
  prerequisites: StockMovementCompensationPreview["prerequisites"];
} {
  const blockers: Array<{ code: string; message: string }> = [];
  const prerequisites: StockMovementCompensationPreview["prerequisites"] = [];
  const addPrerequisite = (args: {
    code: string;
    label: string;
    satisfied: boolean;
    successMessage: string;
    failureMessage: string;
  }) => {
    const message = args.satisfied ? args.successMessage : args.failureMessage;
    prerequisites.push({
      code: args.code,
      label: args.label,
      satisfied: args.satisfied,
      message,
    });
    if (!args.satisfied) blockers.push({ code: args.code, message });
  };

  addPrerequisite({
    code: "INVALID_STATUS",
    label: "Mouvement comptabilisé",
    satisfied: detail.movement.status === "POSTED",
    successMessage: "Le mouvement d'origine est comptabilisé et reste immuable.",
    failureMessage:
      "Le mouvement doit être comptabilisé (statut POSTED) avant de préparer une compensation.",
  });

  const hasPostedAt = Boolean(detail.movement.posted_at);
  addPrerequisite({
    code: "POSTED_AT_MISSING",
    label: "Date de comptabilisation disponible",
    satisfied: hasPostedAt,
    successMessage: "La date de comptabilisation de l'écriture d'origine est disponible.",
    failureMessage:
      "La date de comptabilisation est absente. Rechargez le mouvement ou contactez le support Stock avant de continuer.",
  });

  if (detail.movement.posted_at) {
    const postingTimestampMatches =
      new Date(detail.movement.posted_at).getTime() ===
      new Date(body.expected_posted_at).getTime();
    addPrerequisite({
      code: "CONCURRENT_MODIFICATION",
      label: "Aperçu à jour",
      satisfied: postingTimestampMatches,
      successMessage: "Le mouvement n'a pas changé depuis son chargement.",
      failureMessage:
        "Le mouvement a changé depuis son chargement. Rechargez la fiche puis relancez la prévisualisation.",
    });
  }

  addPrerequisite({
    code: "MOVEMENT_LINES_MISSING",
    label: "Lignes de stock traçables",
    satisfied: detail.lines.length > 0,
    successMessage: "Les lignes de l'écriture d'origine sont traçables.",
    failureMessage:
      "Aucune ligne traçable n'est disponible. Vérifiez l'écriture d'origine avant de continuer.",
  });

  const movementType = detail.movement.movement_type;
  const movementTypePrerequisite = (() => {
    if (movementType === "SCRAP" || movementType === "DEPRECIATE") {
      return {
        code: "QUALITY_FLOW_REQUIRED",
        failureMessage:
          "Les rebuts et dépréciations se corrigent depuis le flux Qualité dédié.",
      };
    }
    if (movementType === "RESERVE" || movementType === "UNRESERVE") {
      return {
        code: "RESERVATION_FLOW_REQUIRED",
        failureMessage:
          "Les réservations se corrigent depuis leur cycle de vie dédié.",
      };
    }
    const supported = new Set(["IN", "OUT", "TRANSFER", "ADJUST", "ADJUSTMENT"]);
    return supported.has(movementType)
      ? null
      : {
          code: "MOVEMENT_NOT_COMPENSABLE",
          failureMessage:
            "Ce type de mouvement ne peut pas être compensé automatiquement. Contactez le responsable Stock.",
        };
  })();
  addPrerequisite({
    code: movementTypePrerequisite?.code ?? "MOVEMENT_TYPE_SUPPORTED",
    label: "Type de mouvement pris en charge",
    satisfied: movementTypePrerequisite === null,
    successMessage: "Le type de mouvement peut produire un brouillon inverse.",
    failureMessage:
      movementTypePrerequisite?.failureMessage ??
      "Ce type de mouvement ne peut pas être compensé automatiquement.",
  });

  if (blockers.length) return { movement: null, blockers, prerequisites };

  let reverseType: CreateMovementBodyDTO["movement_type"];
  switch (detail.movement.movement_type) {
    case "IN":
      reverseType = "OUT";
      break;
    case "OUT":
      reverseType = "IN";
      break;
    case "TRANSFER":
      reverseType = "TRANSFER";
      break;
    case "ADJUST":
    case "ADJUSTMENT":
      reverseType = "ADJUSTMENT";
      break;
    default:
      return {
        movement: null,
        blockers: [
          {
            code: "MOVEMENT_NOT_COMPENSABLE",
            message:
              "Ce type de mouvement ne peut pas être compensé automatiquement. Contactez le responsable Stock.",
          },
        ],
        prerequisites,
      };
  }

  const reverseLines: CreateMovementLineDTO[] = detail.lines.map((line) => {
    const base = {
      line_no: line.line_no,
      article_id: line.article_id,
      lot_id: line.lot_id,
      qty: Math.abs(line.qty),
      unite: line.unite,
      unit_cost: line.unit_cost,
      currency: line.currency,
      note: `Compensation ${detail.movement.movement_no ?? detail.movement.id}`,
    };
    if (reverseType === "OUT") {
      return {
        ...base,
        src_magasin_id: line.dst_magasin_id,
        src_emplacement_id: line.dst_emplacement_id,
        dst_magasin_id: null,
        dst_emplacement_id: null,
      };
    }
    if (reverseType === "IN") {
      return {
        ...base,
        src_magasin_id: null,
        src_emplacement_id: null,
        dst_magasin_id: line.src_magasin_id,
        dst_emplacement_id: line.src_emplacement_id,
      };
    }
    if (reverseType === "TRANSFER") {
      return {
        ...base,
        src_magasin_id: line.dst_magasin_id,
        src_emplacement_id: line.dst_emplacement_id,
        dst_magasin_id: line.src_magasin_id,
        dst_emplacement_id: line.src_emplacement_id,
      };
    }

    const originalWasInbound = detail.movement.qty > 0;
    return originalWasInbound
      ? {
          ...base,
          src_magasin_id: line.dst_magasin_id,
          src_emplacement_id: line.dst_emplacement_id,
          dst_magasin_id: null,
          dst_emplacement_id: null,
          direction: "OUT" as const,
        }
      : {
          ...base,
          src_magasin_id: null,
          src_emplacement_id: null,
          dst_magasin_id: line.src_magasin_id,
          dst_emplacement_id: line.src_emplacement_id,
          direction: "IN" as const,
        };
  });

  return {
    blockers,
    prerequisites,
    movement: {
      movement_type: reverseType,
      effective_at: new Date().toISOString(),
      source_document_type: "STOCK_COMPENSATION",
      source_document_id: detail.movement.id,
      reason_code: "COMPENSATION",
      notes:
        body.notes ??
        `${body.reason} — compensation de ${detail.movement.movement_no ?? detail.movement.id}`,
      idempotency_key: null,
      lines: reverseLines,
    },
  };
}

export async function repoPreviewMovementCompensation(
  id: string,
  body: CompensateMovementBodyDTO
): Promise<StockMovementCompensationPreview | null> {
  const detail = await repoGetMovement(id);
  if (!detail) return null;
  const existing = await db.query<{ id: string; movement_no: string | null; status: string }>(
    `
      SELECT id::text AS id, movement_no, status
      FROM public.stock_movements
      WHERE reversal_of_id = $1::uuid
        AND status::text <> 'CANCELLED'
      LIMIT 1
    `,
    [id]
  );
  const built = buildCompensatingMovementBody(detail, body);
  if(await consumableWithdrawalOwnsMovement(db,id))built.blockers.push({code:'CONSUMABLE_WITHDRAWAL_CORRECTION_REQUIRED',message:'Ce mouvement est lié à un prélèvement OF. Sa correction doit rapprocher la sortie et la réservation consommée.'});
  if (await assemblyComponentWithdrawalOwnsMovement(db, id)) built.blockers.push({ code: 'ASSEMBLY_COMPONENT_CORRECTION_REQUIRED', message: 'La correction doit rapprocher les composants mis en montage et leurs réservations consommées.' });
  const materialOwned=(await db.query(`SELECT 1 FROM public.production_material_debit_sources WHERE stock_movement_id=$1::uuid
    UNION ALL SELECT 1 FROM public.production_material_remnants WHERE stock_movement_id=$1::uuid LIMIT 1`,[id])).rows.length>0;
  if(materialOwned)built.blockers.push({code:'MATERIAL_DEBIT_CORRECTION_REQUIRED',message:'Corrigez ce mouvement depuis le débit matière de l’OF pour conserver ensemble stock, bruts et transferts.'});
  if (!built.blockers.length && detail.movement.stock_batch_id && !existing.rows.length) {
    const physicalPreview = await db.connect();
    try {
      await physicalPreview.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const eligible = await previewMaterialBarCompensationTx(physicalPreview, id);
      await physicalPreview.query('COMMIT');
      if (eligible) built.prerequisites.push({ code:'MATERIAL_BAR_COMPENSATION_READY',label:'Barres d’origine disponibles',
        satisfied:true,message:'Les barres seront reprises automatiquement depuis le mouvement d’origine.' });
    } catch (error) {
      await physicalPreview.query('ROLLBACK');
      if (!(error instanceof HttpError)) throw error;
      built.blockers.push({ code:error.code,message:error.message });
      built.prerequisites.push({ code:error.code,label:'Barres d’origine disponibles',satisfied:false,message:error.message });
    } finally { physicalPreview.release(); }
  }
  const existingCompensation = existing.rows[0] ?? null;
  const noExistingCompensation = !existingCompensation;
  const existingMessage = existingCompensation
    ? `La compensation ${existingCompensation.movement_no ?? existingCompensation.id} existe déjà au statut ${existingCompensation.status}. Ouvrez-la au lieu de créer un doublon.`
    : "Aucune compensation active n'existe pour ce mouvement.";
  built.prerequisites.push({
    code: "COMPENSATION_ALREADY_EXISTS",
    label: "Aucune compensation déjà active",
    satisfied: noExistingCompensation,
    message: existingMessage,
  });
  if (existingCompensation) {
    built.blockers.push({
      code: "COMPENSATION_ALREADY_EXISTS",
      message: existingMessage,
    });
  }
  const proposed = built.blockers.length === 0 && built.movement
    ? {
        movement_type: built.movement.movement_type,
        source_document_type: "STOCK_COMPENSATION" as const,
        source_document_id: id,
        reason_code: "COMPENSATION" as const,
        notes: built.movement.notes ?? body.reason,
        lines: built.movement.lines.map((line) => ({
          article_id: line.article_id,
          lot_id: line.lot_id ?? null,
          qty: line.qty,
          unite: line.unite ?? null,
          src_magasin_id: line.src_magasin_id ?? null,
          src_emplacement_id: line.src_emplacement_id ?? null,
          dst_magasin_id: line.dst_magasin_id ?? null,
          dst_emplacement_id: line.dst_emplacement_id ?? null,
          ...(line.direction ? { direction: line.direction } : {}),
        })),
      }
    : null;

  return {
    authoritative: true,
    as_of: new Date().toISOString(),
    original_movement_id: id,
    original_movement_no: detail.movement.movement_no,
    outcome: existingCompensation
      ? "ALREADY_COMPENSATED"
      : built.blockers.length === 0
        ? "ELIGIBLE"
        : "INELIGIBLE",
    compensable: built.blockers.length === 0,
    blockers: built.blockers,
    prerequisites: built.prerequisites,
    existing_compensation: existingCompensation,
    proposed_movement: proposed,
  };
}

export async function repoCompensateMovement(
  id: string,
  body: CompensateMovementBodyDTO,
  audit: AuditContext,
  idempotencyKey: string
): Promise<StockMovementDetail | null> {
  const key = normalizeIdempotencyKey(idempotencyKey);
  const lockClient = await db.connect();
  let sessionLockHeld = false;
  try {
    await lockClient.query(`SELECT pg_advisory_lock(hashtextextended($1, 0))`, [
      `stock-compensation:${id}`,
    ]);
    sessionLockHeld = true;

    await lockClient.query("BEGIN");
    const existingCommand = await beginStockCommand(lockClient, {
      audit,
      idempotency_key: key,
      command_type: "MOVEMENT_COMPENSATE",
      request_payload: { movement_id: id, ...body },
    });
    if (existingCommand.existing) {
      await lockClient.query("COMMIT");
      return repoGetMovement(existingCommand.existing.resource_id);
    }
    await lockClient.query("COMMIT");

    const preview = await repoPreviewMovementCompensation(id, body);
    if (!preview) return null;
    if (!preview.compensable || !preview.proposed_movement) {
      const blocker = preview.blockers[0] ?? {
        code: "MOVEMENT_NOT_COMPENSABLE",
        message: "Le mouvement ne peut pas être compensé.",
      };
      throw new HttpError(409, blocker.code, blocker.message, { blockers: preview.blockers });
    }

    const detail = await repoGetMovement(id);
    if (!detail) return null;
    const built = buildCompensatingMovementBody(detail, body);
    if (!built.movement) {
      throw new HttpError(
        409,
        "MOVEMENT_NOT_COMPENSABLE",
        "Le mouvement ne peut pas être compensé."
      );
    }
    const derivedKeyHash = hashStockCommand("MOVEMENT_COMPENSATION_CREATE_KEY", {
      actor_user_id: audit.user_id,
      idempotency_key: key,
    });
    const compensation = await repoCreateMovement(
      {
        ...built.movement,
        idempotency_key: `comp-create-${derivedKeyHash}`,
      },
      audit,
      { trusted_source_flow: true }
    );

    await lockClient.query("BEGIN");
    const command = await beginStockCommand(lockClient, {
      audit,
      idempotency_key: key,
      command_type: "MOVEMENT_COMPENSATE",
      request_payload: { movement_id: id, ...body },
    });
    if (command.existing) {
      await lockClient.query("COMMIT");
      return repoGetMovement(command.existing.resource_id);
    }

    const locked = await lockClient.query<{ original_status: string; compensation_status: string }>(
      `
        SELECT
          original.status::text AS original_status,
          compensation.status::text AS compensation_status
        FROM public.stock_movements original
        JOIN public.stock_movements compensation ON compensation.id = $2::uuid
        WHERE original.id = $1::uuid
        FOR UPDATE OF original, compensation
      `,
      [id, compensation.movement.id]
    );
    const state = locked.rows[0] ?? null;
    if (!state) throw new HttpError(409, "MOVEMENT_MISSING", "Movement disappeared during compensation");
    if (state.original_status !== "POSTED" || state.compensation_status !== "DRAFT") {
      throw new HttpError(409, "INVALID_STATUS", "Compensation status changed concurrently");
    }

    await lockClient.query(
      `
        UPDATE public.stock_movements
        SET
          reversal_of_id = $2::uuid,
          correlation_id = $3::uuid,
          updated_at = now(),
          updated_by = $4
        WHERE id = $1::uuid
      `,
      [compensation.movement.id, id, command.correlation_id, audit.user_id]
    );
    await insertMovementEvent(lockClient, {
      movement_id: id,
      event_type: "COMPENSATION_PREPARED",
      old_values: null,
      new_values: {
        compensation_movement_id: compensation.movement.id,
        correlation_id: command.correlation_id,
      },
      user_id: audit.user_id,
    });
    await insertMovementEvent(lockClient, {
      movement_id: compensation.movement.id,
      event_type: "LINKED_AS_COMPENSATION",
      old_values: null,
      new_values: {
        reversal_of_id: id,
        correlation_id: command.correlation_id,
      },
      user_id: audit.user_id,
    });
    await insertAuditLog(lockClient, audit, {
      action: "stock.movements.compensation.prepare",
      entity_type: "stock_movements",
      entity_id: compensation.movement.id,
      details: {
        reversal_of_id: id,
        reason: body.reason,
        correlation_id: command.correlation_id,
      },
    });
    await completeStockCommand(lockClient, {
      audit,
      command,
      command_type: "MOVEMENT_COMPENSATE",
      resource_type: "stock_movement",
      resource_id: compensation.movement.id,
      result_payload: {
        compensation_movement_id: compensation.movement.id,
        reversal_of_id: id,
        status: "DRAFT",
      },
    });
    await lockClient.query("COMMIT");
    return repoGetMovement(compensation.movement.id);
  } catch (error) {
    await lockClient.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    if (sessionLockHeld) {
      await lockClient
        .query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [`stock-compensation:${id}`])
        .catch(() => undefined);
    }
    lockClient.release();
  }
}

export async function repoCancelMovement(
  id: string,
  audit: AuditContext,
  idempotencyKey: string
): Promise<StockMovementDetail | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const command = await beginStockCommand(client, {
      audit,
      idempotency_key: idempotencyKey,
      command_type: "MOVEMENT_CANCEL",
      request_payload: { movement_id: id },
    });
    if (command.existing) {
      const existingId = command.existing.resource_id;
      await client.query("COMMIT");
      return repoGetMovement(existingId);
    }

    const lock = await client.query<{ status: string; movement_no: string | null }>(
      `SELECT status, movement_no FROM public.stock_movements WHERE id = $1::uuid FOR UPDATE`,
      [id]
    );
    const m = lock.rows[0] ?? null;
    if (!m) {
      await client.query("ROLLBACK");
      return null;
    }
    if (m.status !== "DRAFT") {
      throw new HttpError(409, "INVALID_STATUS", "Only DRAFT movements can be cancelled");
    }

    await client.query(
      `
        UPDATE public.stock_movements
        SET
          status = 'CANCELLED',
          correlation_id = $3::uuid,
          updated_at = now(),
          updated_by = $2
        WHERE id = $1::uuid
      `,
      [id, audit.user_id, command.correlation_id]
    );

    await insertMovementEvent(client, {
      movement_id: id,
      event_type: "CANCELLED",
      old_values: { status: "DRAFT" },
      new_values: { status: "CANCELLED" },
      user_id: audit.user_id,
    });

    await insertAuditLog(client, audit, {
      action: "stock.movements.cancel",
      entity_type: "stock_movements",
      entity_id: id,
      details: { movement_no: m.movement_no },
    });

    await completeStockCommand(client, {
      audit,
      command,
      command_type: "MOVEMENT_CANCEL",
      resource_type: "stock_movement",
      resource_id: id,
      result_payload: {
        movement_id: id,
        status: "CANCELLED",
      },
    });

    await client.query("COMMIT");
    return repoGetMovement(id);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

type StockDocumentRow = {
  id: string;
  original_name: string;
  stored_name: string;
  storage_path: string;
  mime_type: string;
  size_bytes: string;
  sha256: string | null;
  label: string | null;
  created_at: string;
  updated_at: string;
  uploaded_by: number | null;
  removed_at: string | null;
  removed_by: number | null;
};

async function insertStockDocuments(
  client: PoolClient,
  documents: UploadedDocument[],
  audit: AuditContext,
  baseDirRel: string
): Promise<StockDocumentRow[]> {
  if (!documents.length) return [];

  const baseDirAbs = path.resolve(baseDirRel);
  await fs.mkdir(baseDirAbs, { recursive: true });

  const inserted: StockDocumentRow[] = [];
  for (const doc of documents) {
    const documentId = crypto.randomUUID();
    const safeExt = safeDocExtension(doc.originalname);
    const storedName = `${documentId}${safeExt}`;
    const relPath = toPosixPath(path.join(baseDirRel, storedName));
    const absPath = path.join(baseDirAbs, storedName);
    await transferSecureUploadToDestination(doc, absPath);

    const hash = await sha256File(absPath);

    await client.query(
      `
        INSERT INTO public.documents (id, title, file_path, mime_type, kind)
        VALUES ($1::uuid,$2,$3,$4,$5)
      `,
      [documentId, doc.originalname, relPath, doc.mimetype, "stock"]
    );

    const ins = await client.query<StockDocumentRow>(
      `
        INSERT INTO public.stock_documents (
          id, original_name, stored_name, storage_path, mime_type, size_bytes,
          sha256, label, uploaded_by,
          created_by, updated_by
        )
        VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$9,$9)
        RETURNING
          id::text AS id,
          original_name,
          stored_name,
          storage_path,
          mime_type,
          size_bytes::text AS size_bytes,
          sha256,
          label,
          created_at::text AS created_at,
          updated_at::text AS updated_at,
          uploaded_by,
          removed_at::text AS removed_at,
          removed_by
      `,
      [documentId, doc.originalname, storedName, relPath, doc.mimetype, doc.size, hash, null, audit.user_id]
    );
    const row = ins.rows[0];
    if (!row) throw new Error("Failed to insert stock document");
    inserted.push(row);
  }

  return inserted;
}

export async function repoAttachArticleDocuments(
  articleId: string,
  documents: UploadedDocument[],
  metadata: ArticleDocumentMetadataDTO,
  audit: AuditContext
): Promise<StockDocument[] | null> {
  const docsDirRel = ensureDocumentStoragePath("stock", "articles");
  const client = await db.connect();
  let expected: Array<{ id: string; key: string; absolutePath: string }> = [];
  const result = await withUploadTransaction({
    client,
    files: documents,
    context: "stock.articles.documents.attach",
    work: async () => {

    const exists = await client.query<{ ok: number }>(
      `SELECT 1::int AS ok FROM public.articles WHERE id = $1::uuid FOR UPDATE`,
      [articleId]
    );
    if (!exists.rows[0]?.ok) {
      return null;
    }

    const inserted = await insertStockDocuments(client, documents, audit, docsDirRel);
    expected = inserted.map((document) => ({
      id: document.id,
      key: `${articleId}|${document.id}|${document.sha256 ?? ""}|${document.storage_path}`,
      absolutePath: path.resolve(document.storage_path),
    }));
    for (const d of inserted) {
      await client.query(
        `
          INSERT INTO public.article_documents (
            article_id, document_id, type, revision, version, is_active,
            uploaded_by, created_by, updated_by
          )
          VALUES ($1::uuid,$2::uuid,$3,$4,$5,true,$6,$6,$6)
          ON CONFLICT DO NOTHING
        `,
        [articleId, d.id, metadata.type ?? null, metadata.revision ?? null, 1, audit.user_id]
      );
    }

    await insertAuditLog(client, audit, {
      action: "stock.articles.documents.attach",
      entity_type: "articles",
      entity_id: articleId,
      details: {
        count: inserted.length,
        metadata,
        documents: inserted.map((d) => ({
          id: d.id,
          original_name: d.original_name,
          mime_type: d.mime_type,
          size_bytes: d.size_bytes,
        })),
      },
    });

    return inserted;
    },
    reconcile: async () => {
      if (expected.length === 0) return "committed";
      const { rows } = await db.query<{ article_id: string | null; id: string; sha256: string | null; storage_path: string }>(
        `SELECT ad.article_id::text AS article_id, sd.id::text AS id, sd.sha256, sd.storage_path
           FROM public.stock_documents sd
           LEFT JOIN public.article_documents ad
             ON ad.document_id = sd.id AND ad.article_id = $1::uuid
          WHERE sd.id = ANY($2::uuid[])`,
        [articleId, expected.map((entry) => entry.id)]
      );
      const status = classifyUploadReconciliation(
        expected.map((entry) => entry.key),
        rows.map((row) => `${row.article_id ?? ""}|${row.id}|${row.sha256 ?? ""}|${row.storage_path}`)
      );
      if (status !== "committed") return status;
      const present = await Promise.all(expected.map((entry) => fs.stat(entry.absolutePath).then((stat) => stat.isFile()).catch(() => false)));
      return present.every(Boolean) ? "committed" : "uncertain";
    },
  });
  if (result === null) return null;
  return repoListArticleDocuments(articleId);
}

export async function repoRemoveArticleDocument(
  articleId: string,
  documentId: string,
  audit: AuditContext
): Promise<boolean | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const exists = await client.query<{ ok: number }>(
      `SELECT 1::int AS ok FROM public.articles WHERE id = $1::uuid FOR UPDATE`,
      [articleId]
    );
    if (!exists.rows[0]?.ok) {
      await client.query("ROLLBACK");
      return null;
    }

    const del = await client.query(
      `UPDATE public.article_documents
       SET is_active = false,
           retired_at = now(),
           retired_by = $3,
           updated_at = now(),
           updated_by = $3
       WHERE article_id = $1::uuid
         AND document_id = $2::uuid
         AND is_active = true`,
      [articleId, documentId, audit.user_id]
    );
    const removed = (del.rowCount ?? 0) > 0;
    if (!removed) {
      await client.query("ROLLBACK");
      return false;
    }

    await insertAuditLog(client, audit, {
      action: "stock.articles.documents.remove",
      entity_type: "stock_documents",
      entity_id: documentId,
      details: { article_id: articleId },
    });

    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function repoGetArticleDocumentForDownload(
  articleId: string,
  documentId: string,
  audit: AuditContext
): Promise<{ storage_path: string; mime_type: string; original_name: string } | null> {
  const res = await db.query<{ storage_path: string; mime_type: string; original_name: string }>(
    `
      SELECT
        sd.storage_path,
        sd.mime_type,
        sd.original_name
      FROM public.article_documents ad
      JOIN public.stock_documents sd ON sd.id = ad.document_id
      WHERE ad.article_id = $1::uuid
        AND ad.document_id = $2::uuid
        AND ad.is_active = true
        AND sd.removed_at IS NULL
      LIMIT 1
    `,
    [articleId, documentId]
  );
  const row = res.rows[0] ?? null;
  if (!row) return null;

  await insertAuditLog(db, audit, {
    action: "stock.articles.documents.download",
    entity_type: "stock_documents",
    entity_id: documentId,
    details: { article_id: articleId, original_name: row.original_name },
  });

  return row;
}

export async function repoListMovementDocuments(movementId: string): Promise<StockDocument[] | null> {
  const exists = await db.query<{ ok: number }>(
    `SELECT 1::int AS ok FROM public.stock_movements WHERE id = $1::uuid`,
    [movementId]
  );
  if (!exists.rows[0]?.ok) return null;

  const res = await db.query<StockDocument>(
    `
      SELECT
        sd.id::text AS document_id,
        sd.original_name AS document_name,
        md.type
      FROM public.stock_movement_documents md
      JOIN public.stock_documents sd ON sd.id = md.document_id
      WHERE md.stock_movement_id = $1::uuid
        AND sd.removed_at IS NULL
      ORDER BY md.created_at DESC, md.id DESC
    `,
    [movementId]
  );
  return res.rows;
}

export async function repoAttachMovementDocuments(
  movementId: string,
  documents: UploadedDocument[],
  audit: AuditContext
): Promise<StockDocument[] | null> {
  const docsDirRel = ensureDocumentStoragePath("stock", "movements");
  const client = await db.connect();
  let expected: Array<{ id: string; key: string; absolutePath: string }> = [];
  const result = await withUploadTransaction({
    client,
    files: documents,
    context: "stock.movements.documents.attach",
    work: async () => {

    const exists = await client.query<{ ok: number }>(
      `SELECT 1::int AS ok FROM public.stock_movements WHERE id = $1::uuid FOR UPDATE`,
      [movementId]
    );
    if (!exists.rows[0]?.ok) {
      return null;
    }

    const inserted = await insertStockDocuments(client, documents, audit, docsDirRel);
    expected = inserted.map((document) => ({
      id: document.id,
      key: `${movementId}|${document.id}|${document.sha256 ?? ""}|${document.storage_path}`,
      absolutePath: path.resolve(document.storage_path),
    }));
    for (const d of inserted) {
      await client.query(
        `
          INSERT INTO public.stock_movement_documents (stock_movement_id, document_id, type, version, uploaded_by, created_by, updated_by)
          VALUES ($1::uuid,$2::uuid,$3,$4,$5,$5,$5)
          ON CONFLICT DO NOTHING
        `,
        [movementId, d.id, null, 1, audit.user_id]
      );
    }

    await insertAuditLog(client, audit, {
      action: "stock.movements.documents.attach",
      entity_type: "stock_movements",
      entity_id: movementId,
      details: {
        count: inserted.length,
        documents: inserted.map((d) => ({
          id: d.id,
          original_name: d.original_name,
          mime_type: d.mime_type,
          size_bytes: d.size_bytes,
        })),
      },
    });

    return inserted;
    },
    reconcile: async () => {
      if (expected.length === 0) return "committed";
      const { rows } = await db.query<{ stock_movement_id: string | null; id: string; sha256: string | null; storage_path: string }>(
        `SELECT md.stock_movement_id::text AS stock_movement_id, sd.id::text AS id, sd.sha256, sd.storage_path
           FROM public.stock_documents sd
           LEFT JOIN public.stock_movement_documents md
             ON md.document_id = sd.id AND md.stock_movement_id = $1::uuid
          WHERE sd.id = ANY($2::uuid[])`,
        [movementId, expected.map((entry) => entry.id)]
      );
      const status = classifyUploadReconciliation(
        expected.map((entry) => entry.key),
        rows.map((row) => `${row.stock_movement_id ?? ""}|${row.id}|${row.sha256 ?? ""}|${row.storage_path}`)
      );
      if (status !== "committed") return status;
      const present = await Promise.all(expected.map((entry) => fs.stat(entry.absolutePath).then((stat) => stat.isFile()).catch(() => false)));
      return present.every(Boolean) ? "committed" : "uncertain";
    },
  });
  if (result === null) return null;
  return repoListMovementDocuments(movementId);
}

export async function repoRemoveMovementDocument(
  movementId: string,
  documentId: string,
  audit: AuditContext
): Promise<boolean | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const exists = await client.query<{ ok: number }>(
      `SELECT 1::int AS ok FROM public.stock_movements WHERE id = $1::uuid FOR UPDATE`,
      [movementId]
    );
    if (!exists.rows[0]?.ok) {
      await client.query("ROLLBACK");
      return null;
    }

    const del = await client.query(
      `DELETE FROM public.stock_movement_documents WHERE stock_movement_id = $1::uuid AND document_id = $2::uuid`,
      [movementId, documentId]
    );
    const removed = (del.rowCount ?? 0) > 0;
    if (!removed) {
      await client.query("ROLLBACK");
      return false;
    }

    await client.query(
      `UPDATE public.stock_documents SET removed_at = now(), removed_by = $2, updated_at = now(), updated_by = $2 WHERE id = $1::uuid AND removed_at IS NULL`,
      [documentId, audit.user_id]
    );

    await insertAuditLog(client, audit, {
      action: "stock.movements.documents.remove",
      entity_type: "stock_documents",
      entity_id: documentId,
      details: { stock_movement_id: movementId },
    });

    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function repoGetMovementDocumentForDownload(
  movementId: string,
  documentId: string,
  audit: AuditContext
): Promise<{ storage_path: string; mime_type: string; original_name: string } | null> {
  const res = await db.query<{ storage_path: string; mime_type: string; original_name: string }>(
    `
      SELECT
        sd.storage_path,
        sd.mime_type,
        sd.original_name
      FROM public.stock_movement_documents md
      JOIN public.stock_documents sd ON sd.id = md.document_id
      WHERE md.stock_movement_id = $1::uuid
        AND md.document_id = $2::uuid
        AND sd.removed_at IS NULL
      LIMIT 1
    `,
    [movementId, documentId]
  );
  const row = res.rows[0] ?? null;
  if (!row) return null;

  await insertAuditLog(db, audit, {
    action: "stock.movements.documents.download",
    entity_type: "stock_documents",
    entity_id: documentId,
    details: { stock_movement_id: movementId, original_name: row.original_name },
  });

  return row;
}
