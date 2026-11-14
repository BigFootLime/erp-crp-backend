import { stockLotTraceReferenceValuesSql } from "../../../shared/provenance/stock-lot-trace.sql";
import { syncSubcontractDefinitionTx } from "./article-subcontract-definition.repository";
import { syncArticleSupplierConditionsTx } from "./article-supplier-conditions.repository";
import { consumableWithdrawalOwnsMovement } from "./consumable-movement-guard";
import { assemblyComponentWithdrawalOwnsMovement } from './assembly-component-movement-guard';
import { syncConsumablePolicyTx, consumablePolicyPatch } from "./consumable-article.repository";
import { syncArticleCommercialTx } from './article-commercial.repository';
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
import { oldMaterialDefinitionFromProjection, type OldMaterialDefinitionProjection } from "./stock-article-projection";
import { repoListArticleDocuments } from "./stock-document-reads.repository";

export { articleSortColumn, normalizedArticleCategorySql, pieceClientCodeSql, tableColumnExists };
async function normalizeArticleState(args: {
  article_type: string | null | undefined;
  article_category: string | null | undefined;
  family_code: string | null | undefined;
  piece_technique_id: string | null;
  article_categories: string[] | null | undefined;
  version_number: number | null | undefined;
  plan_index: number | null | undefined;
  status: string | null | undefined;
  projet_id: number | null | undefined;
  stock_managed: boolean;
  lot_tracking: boolean;
  code: string;
  designation: string;
  client: Pick<PoolClient, "query">;
  preserve_existing_code?: boolean;
}) {
  const categoryFromType = (() => {
    const articleType = typeof args.article_type === "string" ? args.article_type.trim().toUpperCase() : "";
    if (articleType === "PIECE_TECHNIQUE") return "fabrique" as const;
    if (articleType === "PURCHASED") return toBusinessArticleCategory(args.article_category, "achat");
    return toBusinessArticleCategory(args.article_category, "achat");
  })();
  const requestedPrimaryCategory = toBusinessArticleCategory(args.article_category, categoryFromType);
  const categorySelection = normalizeArticleCategorySelection(requestedPrimaryCategory, args.article_categories);
  /**
   * `article_category` is the authoritative primary classification. Business
   * categories are secondary uses and must never silently reclassify an
   * Article just because one of them maps to another primary category.
   *
   * normalizeArticleCategories keeps the matching business category at index
   * zero, which syncArticleCategories persists with is_primary = true.
   */
  const { article_category, article_categories } = categorySelection;
  const article_type = inferArticleType(article_category);
  const piece_technique_id = article_category === "fabrique" ? args.piece_technique_id : null;
  const requestedFamilyCode = normalizeFamilyCode(args.family_code, defaultFamilyCodeForCategory(article_category));
  const family_code = article_category === "matiere"
    ? materialFamilyCanonicalMap[requestedFamilyCode] ?? requestedFamilyCode
    : requestedFamilyCode;
  const version_number = typeof args.version_number === "number" && Number.isFinite(args.version_number) ? Math.max(1, Math.trunc(args.version_number)) : 1;
  const plan_index = typeof args.plan_index === "number" && Number.isFinite(args.plan_index) ? Math.max(1, Math.trunc(args.plan_index)) : 1;
  const status = normalizeArticleWorkflowStatus(args.status);
  const projet_id = typeof args.projet_id === "number" && Number.isFinite(args.projet_id) ? Math.trunc(args.projet_id) : null;
  const stock_managed = args.stock_managed;
  const lot_tracking = stock_managed ? args.lot_tracking : false;

  if (article_category === "fabrique" && !piece_technique_id) {
    throw new HttpError(400, "INVALID_ARTICLE", "Fabricated articles require piece_technique_id");
  }
  if (article_category !== "fabrique" && piece_technique_id) {
    throw new HttpError(400, "INVALID_ARTICLE", "Only fabricated articles can be linked to a piece technique");
  }

  if (projet_id) {
    await ensureProjetAffaireExists(args.client, projet_id);
  }

  const code = args.preserve_existing_code
    ? args.code
    : await resolveArticleCode(args.client, {
        code: args.code,
        designation: args.designation,
        category: article_category,
        family_code,
        piece_technique_id,
      });

  return {
    article_type: article_type as "PIECE_TECHNIQUE" | "PURCHASED",
    article_category,
    article_categories,
    family_code,
    version_number,
    plan_index,
    status,
    projet_id,
    piece_technique_id,
    stock_managed,
    lot_tracking,
    code,
  };
}

async function ensurePieceTechniqueExists(client: Pick<PoolClient, "query">, pieceTechniqueId: string) {
  const res = await client.query<{ ok: number }>(
    `SELECT 1::int AS ok FROM public.pieces_techniques WHERE id = $1::uuid LIMIT 1`,
    [pieceTechniqueId]
  );
  if (!res.rows[0]?.ok) {
    throw new HttpError(400, "INVALID_PIECE_TECHNIQUE", "Unknown piece_technique_id");
  }
}

async function syncPieceTechniqueArticleLink(
  client: Pick<PoolClient, "query">,
  args: {
    article_id: string;
    previous_piece_technique_id: string | null;
    next_piece_technique_id: string | null;
  }
) {
  if (args.previous_piece_technique_id && args.previous_piece_technique_id !== args.next_piece_technique_id) {
    await client.query(
      `UPDATE public.pieces_techniques SET article_id = NULL WHERE id = $1::uuid AND article_id = $2::uuid`,
      [args.previous_piece_technique_id, args.article_id]
    );
  }

  if (!args.next_piece_technique_id) {
    await client.query(`UPDATE public.pieces_techniques SET article_id = NULL WHERE article_id = $1::uuid`, [args.article_id]);
    return;
  }

  await ensurePieceTechniqueExists(client, args.next_piece_technique_id);
  await client.query(`UPDATE public.pieces_techniques SET article_id = $2::uuid WHERE id = $1::uuid`, [args.next_piece_technique_id, args.article_id]);
}

function articleDetailTable(category: ArticleCategory): string {
  if (category === "fabrique") return "articles_fabrique";
  if (category === "matiere") return "articles_matiere";
  if (category === "traitement") return "articles_traitement";
  return "articles_achat";
}

async function ensureArticleFamilyEntry(
  client: Pick<PoolClient, "query">,
  category: ArticleCategory,
  familyCode: string
) {
  const table = articleFamilyTable(category);
  await client.query(
    `
      INSERT INTO public.${table} (code, designation)
      VALUES ($1, $1)
      ON CONFLICT (code) DO UPDATE SET updated_at = now()
    `,
    [familyCode]
  );
}

export async function syncArticleSubtypeDetails(
  client: Pick<PoolClient, "query">,
  args: {
    article_id: string;
    category: ArticleCategory;
    family_code: string;
    piece_technique_id: string | null;
    article_matiere?: CreateArticleBodyDTO["article_matiere"];
    fourniture_client?: CreateArticleBodyDTO["fourniture_client"] | UpdateArticleBodyDTO["fourniture_client"];
  }
) {
  await ensureArticleFamilyEntry(client, args.category, args.family_code);

  const detailTables = [
    "articles_fabrique",
    "articles_matiere",
    "articles_traitement",
    "articles_achat",
  ] as const;

  for (const table of detailTables) {
    if (table === articleDetailTable(args.category)) continue;
    await client.query(`DELETE FROM public.${table} WHERE article_id = $1::uuid`, [args.article_id]);
  }

  if (args.category === "fabrique") {
    await client.query(
      `
        INSERT INTO public.articles_fabrique (article_id, family_code, piece_technique_id)
        VALUES ($1::uuid,$2,$3::uuid)
        ON CONFLICT (article_id) DO UPDATE
        SET family_code = EXCLUDED.family_code,
            piece_technique_id = EXCLUDED.piece_technique_id,
            updated_at = now()
      `,
      [args.article_id, args.family_code, args.piece_technique_id]
    );
    return;
  }

  if (args.category === "matiere" && args.article_matiere) {
    const m = args.article_matiere;
    const remainingColumnsAvailable = await tableColumnExists(
      client,
      "articles_matiere",
      "longueur_coupe_mm"
    );
    if (
      !remainingColumnsAvailable
      && (
        m.client_proprietaire_id
        || m.longueur_coupe_mm
        || m.quantite_lineaire_totale_mm
        || (m.barre_a_decouper && !(m.longueur_barre_source_mm ?? m.longueur_unitaire_mm))
      )
    ) {
      throw new HttpError(
        503,
        "STOCK_SCHEMA_UPGRADE_REQUIRED",
        "Le patch additif #164 doit être appliqué sur cet environnement avant d'enregistrer ces règles matière."
      );
    }
    const legacyLongueur = m.longueur_brut_mm ?? m.longueur_mm ?? null;
    const legacyLongueurUnitaire = m.longueur_barre_source_mm ?? m.longueur_unitaire_mm ?? null;
    await client.query(
      `
        INSERT INTO public.articles_matiere (
          article_id,
          family_code,
          nuance_id,
          etat_id,
          sous_etat_id,
          barre_a_decouper,
          longueur_mm,
          longueur_unitaire_mm,
          largeur_mm,
          hauteur_mm,
          epaisseur_mm,
          diametre_mm,
          largeur_plat_mm
        )
        VALUES (
          $1::uuid,
          $2,
          $3::bigint,
          $4::bigint,
          $5::bigint,
          $6,
          $7::int,
          $8::int,
          $9::int,
          $10::int,
          $11::int,
          $12::int,
          $13::int
        )
        ON CONFLICT (article_id) DO UPDATE
        SET family_code = EXCLUDED.family_code,
            nuance_id = EXCLUDED.nuance_id,
            etat_id = EXCLUDED.etat_id,
            sous_etat_id = EXCLUDED.sous_etat_id,
            barre_a_decouper = EXCLUDED.barre_a_decouper,
            longueur_mm = EXCLUDED.longueur_mm,
            longueur_unitaire_mm = EXCLUDED.longueur_unitaire_mm,
            largeur_mm = EXCLUDED.largeur_mm,
            hauteur_mm = EXCLUDED.hauteur_mm,
            epaisseur_mm = EXCLUDED.epaisseur_mm,
            diametre_mm = EXCLUDED.diametre_mm,
            largeur_plat_mm = EXCLUDED.largeur_plat_mm,
            updated_at = now()
      `,
      [
        args.article_id,
        args.family_code,
        m.nuance_id ?? null,
        m.etat_id ?? null,
        m.sous_etat_id ?? null,
        m.barre_a_decouper ?? false,
        legacyLongueur,
        legacyLongueurUnitaire,
        m.largeur_mm ?? null,
        m.hauteur_mm ?? null,
        m.epaisseur_mm ?? null,
        m.diametre_mm ?? null,
        m.largeur_plat_mm ?? null,
      ]
    );
    if (remainingColumnsAvailable) {
      await client.query(
        `UPDATE public.articles_matiere
         SET client_proprietaire_id = $2,
             longueur_barre_source_mm = $3::int,
             longueur_coupe_mm = $4::int,
             longueur_brut_mm = $5::int,
             quantite_lineaire_totale_mm = $6::numeric,
             updated_at = now()
         WHERE article_id = $1::uuid`,
        [
          args.article_id,
          m.client_proprietaire_id ?? null,
          m.longueur_barre_source_mm ?? m.longueur_unitaire_mm ?? null,
          m.longueur_coupe_mm ?? null,
          m.longueur_brut_mm ?? m.longueur_mm ?? null,
          m.quantite_lineaire_totale_mm ?? null,
        ]
      );
    }
    return;
  }

  const table = articleDetailTable(args.category);
  await client.query(
    `
      INSERT INTO public.${table} (article_id, family_code)
      VALUES ($1::uuid,$2)
      ON CONFLICT (article_id) DO UPDATE
      SET family_code = EXCLUDED.family_code,
          updated_at = now()
    `,
    [args.article_id, args.family_code]
  );

  if (args.category === "achat" && args.fourniture_client) {
    await client.query(
      `UPDATE public.articles_achat SET reference_client = $2, indice_client = $3, numero_client = $4, updated_at = now() WHERE article_id = $1::uuid`,
      [args.article_id, args.fourniture_client.reference, args.fourniture_client.indice ?? null, args.fourniture_client.numero_client]
    );
  }
}

async function tableColumnExists(
  queryer: Pick<PoolClient, "query">,
  tableName: string,
  columnName: string
): Promise<boolean> {
  const result = await queryer.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = $1
         AND column_name = $2
     ) AS present`,
    [tableName, columnName]
  );
  return result.rows[0]?.present === true;
}

async function syncArticleProcurementProfile(
  client: Pick<PoolClient, "query">,
  articleId: string,
  procurement: CreateArticleBodyDTO["procurement"] | UpdateArticleBodyDTO["procurement"],
  actorUserId: number
) {
  if (!procurement) return;

  if (procurement.preferred_catalogue_id) {
    const preferred = await client.query<{ ok: number }>(
      `SELECT 1::int AS ok
       FROM public.fournisseur_catalogue
       WHERE id = $1::uuid AND article_id = $2::uuid AND actif = true
       LIMIT 1`,
      [procurement.preferred_catalogue_id, articleId]
    );
    if (!preferred.rows[0]?.ok) {
      throw new HttpError(400, "INVALID_PREFERRED_SUPPLIER_REFERENCE", "The preferred supplier catalogue reference must be active and linked to this article.");
    }
  }

  await client.query(
    `
      INSERT INTO public.article_procurement_profile (
        article_id, manufacturer_name, manufacturer_reference, preferred_catalogue_id,
        packaging, process, finish, requirements, certificate_required,
        min_stock, max_stock, created_by, updated_by
      )
      VALUES ($1::uuid,$2,$3,$4::uuid,$5,$6,$7,$8,$9,$10,$11,$12,$12)
      ON CONFLICT (article_id) DO UPDATE SET
        manufacturer_name = EXCLUDED.manufacturer_name,
        manufacturer_reference = EXCLUDED.manufacturer_reference,
        preferred_catalogue_id = EXCLUDED.preferred_catalogue_id,
        packaging = EXCLUDED.packaging,
        process = EXCLUDED.process,
        finish = EXCLUDED.finish,
        requirements = EXCLUDED.requirements,
        certificate_required = EXCLUDED.certificate_required,
        min_stock = EXCLUDED.min_stock,
        max_stock = EXCLUDED.max_stock,
        updated_at = now(),
        updated_by = EXCLUDED.updated_by
    `,
    [
      articleId,
      procurement.manufacturer_name ?? null,
      procurement.manufacturer_reference ?? null,
      procurement.preferred_catalogue_id ?? null,
      procurement.packaging ?? null,
      procurement.process ?? null,
      procurement.finish ?? null,
      procurement.requirements ?? null,
      procurement.certificate_required ?? false,
      procurement.min_stock ?? null,
      procurement.max_stock ?? null,
      actorUserId,
    ]
  );
}

async function ensureArticleCanDisableStockManagement(client: Pick<PoolClient, "query">, articleId: string) {
  const res = await client.query<{ qty_total: number; qty_reserved: number }>(
    `
      SELECT
        COALESCE(SUM(qty_total), 0)::float8 AS qty_total,
        COALESCE(SUM(qty_reserved), 0)::float8 AS qty_reserved
      FROM public.v_stock_availability_225
      WHERE article_id = $1::uuid
    `,
    [articleId]
  );
  const row = res.rows[0] ?? { qty_total: 0, qty_reserved: 0 };
  if (Math.abs(Number(row.qty_total ?? 0)) > 0.0001 || Math.abs(Number(row.qty_reserved ?? 0)) > 0.0001) {
    throw new HttpError(409, "ARTICLE_HAS_STOCK", "This article still has stock or reservations and cannot be switched to non-stock-managed");
  }
}

// client_id is a technical key; only the linked customer's business code is displayed.
// Preserve a historical code only when it is distinct from that technical key.
function pieceClientCodeSql(pieceAlias = "pt"): string {
  return `COALESCE(NULLIF(btrim(piece_client.client_code), ''), NULLIF(NULLIF(btrim(${pieceAlias}.code_client), ''), btrim(${pieceAlias}.client_id)))`;
}

function articleSortColumn(sortBy: ListArticlesQueryDTO["sortBy"]): string {
  switch (sortBy) {
    case "created_at":
      return "a.created_at";
    case "code":
      return "a.code";
    case "designation":
      return "a.designation";
    case "plan_reference":
      return "latest_version.plan_reference";
    case "client_code":
      return pieceClientCodeSql();
    case "qty_total":
      return "COALESCE(bs.qty_total, 0)";
    case "qty_available":
      return "COALESCE(bs.qty_available, 0)";
    case "available_lots_count":
      return "COALESCE(lots_available.available_lots_count, 0)";
    case "updated_at":
    default:
      return "a.updated_at";
  }
}

async function ensureProjetAffaireExists(client: Pick<PoolClient, "query">, projetId: number) {
  const res = await client.query<{ ok: number }>(
    `
      SELECT 1::int AS ok
      FROM public.affaire
      WHERE id = $1
        AND type_affaire = 'projet'
      LIMIT 1
    `,
    [projetId]
  );
  if (!res.rows[0]?.ok) {
    throw new HttpError(400, "INVALID_PROJET", "projet_id must reference an existing affaire with type_affaire='projet'");
  }
}

async function syncArticleCategories(
  client: Pick<PoolClient, "query">,
  articleId: string,
  categories: ArticleBusinessCategory[],
  actorUserId: number
) {
  await client.query(`DELETE FROM public.article_category_link WHERE article_id = $1::uuid`, [articleId]);
  for (let i = 0; i < categories.length; i++) {
    const code = categories[i];
    await client.query(
      `
        INSERT INTO public.article_category_link (article_id, category_code, is_primary, created_by)
        VALUES ($1::uuid, $2, $3, $4)
      `,
      [articleId, code, i === 0, actorUserId]
    );
  }
}

function normalizedArticleCategorySql(column = "a.article_category") {
  return `CASE
    WHEN ${column} = 'PIECE_TECHNIQUE' THEN 'fabrique'
    WHEN ${column} = 'MATIERE_PREMIERE' THEN 'matiere'
    WHEN ${column} = 'TRAITEMENT' THEN 'traitement'
    WHEN ${column} = 'FOURNITURE' THEN 'achat'
    ELSE ${column}
  END`;
}

function normalizedBusinessCategorySql(column = "a.article_category") {
  return `CASE
    WHEN ${column} = 'fabrique' THEN 'piece_finie_fabriquee'
    WHEN ${column} = 'PIECE_TECHNIQUE' THEN 'piece_finie_fabriquee'
    WHEN ${column} = 'matiere' THEN 'matiere_premiere'
    WHEN ${column} = 'MATIERE_PREMIERE' THEN 'matiere_premiere'
    WHEN ${column} = 'traitement' THEN 'traitement_surface'
    WHEN ${column} = 'TRAITEMENT' THEN 'traitement_surface'
    ELSE 'achat_revente'
  END`;
}

function articleCategoryFilterSql(column: string, category: ArticleCategory): string {
  if (category === "fabrique") return `(${column} = 'fabrique' OR ${column} = 'PIECE_TECHNIQUE')`;
  if (category === "matiere") return `(${column} = 'matiere' OR ${column} = 'MATIERE_PREMIERE')`;
  if (category === "traitement") return `(${column} = 'traitement' OR ${column} = 'TRAITEMENT')`;
  return `(${column} = 'achat' OR ${column} = 'FOURNITURE')`;
}

export async function assertCanonicalArticleUnit(
  client: Pick<PoolClient, "query">,
  unitCode: string | null | undefined
): Promise<string | null> {
  if (!canonicalizeStockUnitCode(unitCode)) return null;
  const unit = await findCanonicalStockUnit(client, unitCode);
  if (!unit) {
    const submitted = unitCode?.trim() ?? "";
    throw new HttpError(
      400,
      "INVALID_ARTICLE_UNIT",
      `L'unité article « ${submitted} » est inconnue. Choisissez un code du référentiel des unités de stock.`
    );
  }
  return unit.code;
}

export async function repoListArticles(filters: ListArticlesQueryDTO): Promise<Paginated<StockArticleListItem>> {
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 20;
  const offset = (page - 1) * pageSize;

  const where: string[] = [];
  const values: unknown[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  if (filters.q && filters.q.trim().length > 0) {
    const q = normalizeLikeQuery(filters.q);
    const p = push(q);
    where.push(`(
      a.code ILIKE ${p}
      OR a.internal_reference ILIKE ${p}
      OR a.commercial_scope ILIKE ${p}
      OR EXISTS(SELECT 1 FROM public.article_client_links acl JOIN public.clients cl ON cl.client_id=acl.client_id
        WHERE acl.article_id=a.id AND concat_ws(' ',cl.client_code,cl.company_name,cl.client_id) ILIKE ${p})
      OR a.designation ILIKE ${p}
      OR a.family_code ILIKE ${p}
      OR COALESCE(pt.code_piece, '') ILIKE ${p}
      OR COALESCE(pt.designation, '') ILIKE ${p}
      OR COALESCE(pt.designation_2, '') ILIKE ${p}
      OR ${pieceClientCodeSql()} ILIKE ${p}
      OR EXISTS (
        SELECT 1 FROM public.article_procurement_profile app
        WHERE app.article_id = a.id
          AND (COALESCE(app.manufacturer_name, '') ILIKE ${p} OR COALESCE(app.manufacturer_reference, '') ILIKE ${p})
      )
      OR EXISTS (
        SELECT 1
        FROM public.fournisseur_catalogue fc
        JOIN public.fournisseurs f ON f.id = fc.fournisseur_id
        WHERE fc.article_id = a.id
          AND (
            COALESCE(fc.reference_fournisseur, '') ILIKE ${p}
            OR COALESCE(f.nom, f.raison_sociale, '') ILIKE ${p}
            OR COALESCE(f.code, f.code_fournisseur, '') ILIKE ${p}
          )
      )
      OR EXISTS (
        SELECT 1 FROM public.piece_technique_versions ptv_search
        WHERE ptv_search.piece_technique_id = a.piece_technique_id
          AND (COALESCE(ptv_search.plan_reference, '') ILIKE ${p} OR COALESCE(ptv_search.indice, '') ILIKE ${p})
      )
    )`);
  }
  if (filters.client_code) {
    const p = push(filters.client_code);
    where.push(`(LOWER(TRIM(${pieceClientCodeSql()}))=LOWER(TRIM(${p}))
      OR EXISTS(SELECT 1 FROM public.article_client_links acl JOIN public.clients cl ON cl.client_id=acl.client_id
      WHERE acl.article_id=a.id AND LOWER(TRIM(cl.client_code))=LOWER(TRIM(${p}))))`);
  }
  if (filters.article_type) {
    where.push(
      filters.article_type === "PIECE_TECHNIQUE"
        ? articleCategoryFilterSql("a.article_category", "fabrique")
        : `NOT ${articleCategoryFilterSql("a.article_category", "fabrique")}`
    );
  }
  if (filters.article_category) {
    const categoryFilter = articleCategoryFilterSql("a.article_category", filters.article_category);
    where.push(`(
      ${categoryFilter}
      OR EXISTS (
        SELECT 1
        FROM public.article_category_link aclf
        WHERE aclf.article_id = a.id
          AND aclf.category_code = ${push(filters.article_category)}
      )
    )`);
  }
  if (filters.business_category) {
    where.push(`EXISTS (SELECT 1 FROM public.article_category_link business_filter
      WHERE business_filter.article_id = a.id AND business_filter.category_code = ${push(filters.business_category)})`);
  }
  if (filters.status) where.push(`a.status = ${push(filters.status)}`);
  if (filters.projet_id) where.push(`a.projet_id = ${push(filters.projet_id)}`);
  if (filters.family_code) where.push(`a.family_code = ${push(normalizeFamilyCode(filters.family_code, "GEN"))}`);
  if (filters.is_active !== undefined) where.push(`a.is_active = ${push(filters.is_active)}`);
  if (filters.lot_tracking !== undefined) where.push(`a.lot_tracking = ${push(filters.lot_tracking)}`);
  if (filters.stock_managed !== undefined) where.push(`a.stock_managed = ${push(filters.stock_managed)}`);

  /** BUG-CERP-0015 — même prédicat que POST/PATCH /commandes, fermé par défaut. */
  if (filters.commande_client_selectable !== undefined) {
    const predicate = commandeArticleEligibleSql("a");
    where.push(filters.commande_client_selectable ? predicate : `(${predicate}) IS NOT TRUE`);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const orderBy = articleSortColumn(filters.sortBy);
  const orderDir = sortDirection(filters.sortDir);

  const countRes = await db.query<{ total: number }>(
    `
      SELECT COUNT(*)::int AS total
      FROM public.articles a
      LEFT JOIN public.pieces_techniques pt ON pt.id = a.piece_technique_id
      LEFT JOIN public.clients piece_client ON piece_client.client_id = pt.client_id
      ${whereSql}
    `,
    values
  );
  const total = countRes.rows[0]?.total ?? 0;

  const dataSql = `
    SELECT
      a.id::text AS id,
      a.root_article_id::text AS root_article_id,
      a.parent_article_id::text AS parent_article_id,
      a.version_number::int AS version_number,
      a.plan_index::int AS plan_index,
      a.status,
      a.projet_id::int AS projet_id,
      a.code,
      a.designation,
      a.article_category::text AS material_article_category,
      a.designation AS material_designation,
      COALESCE(article_material.family_code, a.family_code)::text AS material_profile_code,
      material_nuance.code::text AS material_nuance_code,
      material_etat.code::text AS material_etat_code,
      material_sous_etat.code::text AS material_sous_etat_code,
      COALESCE(
        article_material.longueur_brut_mm,
        article_material.longueur_coupe_mm,
        article_material.longueur_mm,
        article_material.longueur_unitaire_mm
      )::float8 AS material_longueur_mm,
      article_material.largeur_mm::float8 AS material_largeur_mm,
      article_material.hauteur_mm::float8 AS material_hauteur_mm,
      article_material.epaisseur_mm::float8 AS material_epaisseur_mm,
      article_material.diametre_mm::float8 AS material_diametre_mm,
      a.designation_secondary,
      a.internal_reference, a.consumption_mode, a.purchase_pack_qty::float8 AS purchase_pack_qty, a.receipt_quality_required,
      a.commercial_scope,
      ARRAY(SELECT client_id FROM public.article_client_links c WHERE c.article_id=a.id ORDER BY client_id) AS client_ids,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id',c.client_id,'code',c.client_code,'name',c.company_name) ORDER BY c.client_code) FROM public.article_client_links l JOIN public.clients c ON c.client_id=l.client_id WHERE l.article_id=a.id),'[]'::jsonb) AS associated_clients,
      (SELECT tool_id FROM public.article_tool_links t WHERE t.article_id=a.id) AS tool_id,
      (SELECT stock_article_id::text FROM public.article_receipt_mp_links p WHERE p.article_id=a.id) AS receipt_mp_article_id,
      CASE WHEN ${normalizedArticleCategorySql("a.article_category")} = 'fabrique' THEN 'PIECE_TECHNIQUE' ELSE 'PURCHASED' END AS article_type,
      ${normalizedArticleCategorySql("a.article_category")} AS article_category,
      COALESCE(ac.categories, ARRAY[${normalizedBusinessCategorySql("a.article_category")}]::text[]) AS article_categories,
      a.family_code,
      a.stock_managed,
      a.piece_technique_id::text AS piece_technique_id,
      pt.code_piece AS piece_code,
      pt.designation AS piece_designation,
      ${pieceClientCodeSql()} AS piece_client_code,
      latest_version.plan_reference AS piece_plan_reference,
      latest_version.indice AS piece_indice,
      ${pieceClientCodeSql()} AS client_code,
      latest_version.plan_reference AS plan_reference,
      COALESCE(NULLIF(btrim(a.unite), ''), CASE WHEN ${normalizedArticleCategorySql("a.article_category")} = 'matiere'
        THEN CASE WHEN article_material.barre_a_decouper THEN 'mm' ELSE 'u' END END) AS unite,
      a.lot_tracking,
      a.is_sold,
      a.is_active,
      a.sale_price_reference::float8 AS sale_price_reference,
      a.sale_price_currency,
      a.sale_price_source,
      a.sale_price_source_entity_type,
      a.sale_price_source_entity_id,
      a.sale_price_updated_at::text AS sale_price_updated_at,
      quote_price.suggestion AS quote_price_suggestion,
      ${commandeArticleEligibleSql("a")} AS commande_client_eligible,
      ${commandeArticleIneligibilityCodeSql("a")} AS commande_client_ineligibility_code,
      a.row_version::int AS row_version,
      a.archived_at::text AS archived_at,
      a.archive_reason,
      CASE WHEN av.id IS NULL THEN NULL ELSE jsonb_build_object(
        'id', av.id::text,
        'indice', av.indice,
        'statut', av.statut,
        'plan_reference', av.plan_reference,
        'date_application', av.date_application,
        'manufacturing_mode', av.manufacturing_mode,
        'assembly_supply_strategy', av.assembly_supply_strategy
      ) END AS applicable_version,
      COALESCE(bs.qty_available, 0)::float8 AS qty_available,
      COALESCE(bs.qty_reserved, 0)::float8 AS qty_reserved,
      COALESCE(bs.qty_total, 0)::float8 AS qty_total,
      COALESCE(lots_available.available_lots_count, 0)::int AS available_lots_count,
      COALESCE(bs.locations_count, 0)::int AS locations_count,
      a.updated_at::text AS updated_at,
      a.created_at::text AS created_at
    FROM public.articles a
    LEFT JOIN public.pieces_techniques pt
      ON pt.id = a.piece_technique_id
    LEFT JOIN public.clients piece_client ON piece_client.client_id = pt.client_id
    LEFT JOIN public.articles_matiere article_material
      ON article_material.article_id = a.id
    LEFT JOIN public.stock_nuances material_nuance
      ON material_nuance.id = article_material.nuance_id
    LEFT JOIN public.stock_etats material_etat
      ON material_etat.id = article_material.etat_id
    LEFT JOIN public.stock_sous_etats material_sous_etat
      ON material_sous_etat.id = article_material.sous_etat_id
    LEFT JOIN LATERAL (
      SELECT v.id, v.indice, v.statut, v.plan_reference, v.date_application::text AS date_application,
             v.manufacturing_mode, v.assembly_supply_strategy
      FROM public.piece_technique_versions v
      WHERE v.piece_technique_id = a.piece_technique_id
        AND v.statut = 'APPLICABLE'
      ORDER BY v.date_application DESC NULLS LAST, v.created_at DESC
      LIMIT 1
    ) av ON TRUE
    LEFT JOIN LATERAL (
      SELECT v.indice, v.plan_reference
      FROM public.piece_technique_versions v
      WHERE v.piece_technique_id = a.piece_technique_id
      ORDER BY v.is_current DESC, v.version_interne DESC, v.created_at DESC
      LIMIT 1
    ) latest_version ON TRUE
    LEFT JOIN (
      SELECT
        article_id::text AS article_id,
        COUNT(*)::int AS locations_count,
        COALESCE(SUM(qty_available), 0)::float8 AS qty_available,
        COALESCE(SUM(qty_reserved), 0)::float8 AS qty_reserved,
        COALESCE(SUM(qty_total), 0)::float8 AS qty_total
      FROM public.v_stock_availability_225
      GROUP BY article_id
    ) bs ON bs.article_id = a.id::text
    LEFT JOIN (
      SELECT article_id::text AS article_id, COUNT(DISTINCT lot_id)::int AS available_lots_count
      FROM public.v_stock_availability_225
      WHERE lot_id IS NOT NULL AND qty_available > 0
      GROUP BY article_id
    ) lots_available ON lots_available.article_id = a.id::text
    LEFT JOIN LATERAL (
      SELECT array_agg(acl.category_code ORDER BY acl.is_primary DESC, acl.category_code ASC)::text[] AS categories
      FROM public.article_category_link acl
      WHERE acl.article_id = a.id
    ) ac ON TRUE
    LEFT JOIN LATERAL (
      SELECT jsonb_build_object(
        'devis_id', d.id,
        'devis_numero', d.numero,
        'devis_ligne_id', dl.id,
        'price', dl.prix_unitaire_ht,
        'designation', dl.description,
        'code_piece', a.code,
        'source_article_devis_id', CASE WHEN ad.source_official_article_id = a.id THEN ad.id ELSE NULL END,
        'source_dossier_devis_id', CASE WHEN ad.source_official_article_id = a.id THEN dd.id ELSE NULL END
      ) AS suggestion
      FROM public.devis_ligne dl
      JOIN public.devis d ON d.id = dl.devis_id
      LEFT JOIN public.article_devis ad ON ad.devis_ligne_id = dl.id
      LEFT JOIN public.dossier_technique_piece_devis dd ON dd.article_devis_id = ad.id
      WHERE $${values.length + 1}::text IS NOT NULL
        AND d.client_id = $${values.length + 1}::text
        AND d.statut = 'ACCEPTE'
        AND (dl.article_id = a.id OR ad.source_official_article_id = a.id)
      ORDER BY d.updated_at DESC, dl.id DESC
      LIMIT 1
    ) quote_price ON TRUE
    ${whereSql}
    ORDER BY ${orderBy} ${orderDir}
    LIMIT $${values.length + 2}
    OFFSET $${values.length + 3}
  `;

  type ArticleRow = Omit<StockArticleListItem, "old_material_definition"> & OldMaterialDefinitionProjection;
  const rows = await db.query<ArticleRow>(dataSql, [...values, filters.client_id ?? null, pageSize, offset]);
  const items = rows.rows.map((row): StockArticleListItem => {
    const {
      material_article_category,
      material_designation,
      material_profile_code,
      material_nuance_code,
      material_etat_code,
      material_sous_etat_code,
      material_longueur_mm,
      material_largeur_mm,
      material_hauteur_mm,
      material_epaisseur_mm,
      material_diametre_mm,
      ...article
    } = row;
    const projection: OldMaterialDefinitionProjection = {
      material_article_category,
      material_designation,
      material_profile_code,
      material_nuance_code,
      material_etat_code,
      material_sous_etat_code,
      material_longueur_mm,
      material_largeur_mm,
      material_hauteur_mm,
      material_epaisseur_mm,
      material_diametre_mm,
    };
    return { ...article, old_material_definition: oldMaterialDefinitionFromProjection(projection) };
  });
  return { items, total };
}

export async function repoGetArticle(id: string, includeCosts = false): Promise<StockArticleDetail | null> {
  const res = await db.query<StockArticleDetail>(
    `
      SELECT
        a.id::text AS id,
        a.root_article_id::text AS root_article_id,
        a.parent_article_id::text AS parent_article_id,
        a.version_number::int AS version_number,
        a.plan_index::int AS plan_index,
        a.status,
        a.projet_id::int AS projet_id,
        a.code,
        a.designation,
        a.designation_secondary,
        a.internal_reference, a.consumption_mode, a.purchase_pack_qty::float8 AS purchase_pack_qty, a.receipt_quality_required,
        a.commercial_scope,
        ARRAY(SELECT client_id FROM public.article_client_links c WHERE c.article_id=a.id ORDER BY client_id) AS client_ids,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('id',c.client_id,'code',c.client_code,'name',c.company_name) ORDER BY c.client_code) FROM public.article_client_links l JOIN public.clients c ON c.client_id=l.client_id WHERE l.article_id=a.id),'[]'::jsonb) AS associated_clients,
        (SELECT tool_id FROM public.article_tool_links t WHERE t.article_id=a.id) AS tool_id,
        (SELECT stock_article_id::text FROM public.article_receipt_mp_links p WHERE p.article_id=a.id) AS receipt_mp_article_id,
        CASE WHEN ${normalizedArticleCategorySql("a.article_category")} = 'fabrique' THEN 'PIECE_TECHNIQUE' ELSE 'PURCHASED' END AS article_type,
        ${normalizedArticleCategorySql("a.article_category")} AS article_category,
      COALESCE(ac.categories, ARRAY[${normalizedBusinessCategorySql("a.article_category")}]::text[]) AS article_categories,
        a.family_code,
        a.stock_managed,
        a.piece_technique_id::text AS piece_technique_id,
        pt.code_piece AS piece_code,
        pt.designation AS piece_designation,
        ${pieceClientCodeSql()} AS piece_client_code,
        ${pieceClientCodeSql()} AS client_code,
        latest_version.plan_reference AS piece_plan_reference,
        latest_version.indice AS piece_indice,
        latest_version.plan_reference AS plan_reference,
        COALESCE(NULLIF(btrim(a.unite), ''), CASE WHEN ${normalizedArticleCategorySql("a.article_category")} = 'matiere'
          THEN CASE WHEN am.barre_a_decouper THEN 'mm' ELSE 'u' END END) AS unite,
         a.lot_tracking,
         a.is_sold,
         a.is_active,
         a.sale_price_reference::float8 AS sale_price_reference,
         a.sale_price_currency,
         a.sale_price_source,
         a.sale_price_source_entity_type,
         a.sale_price_source_entity_id,
         a.sale_price_updated_at::text AS sale_price_updated_at,
         NULL::jsonb AS quote_price_suggestion,
         ${commandeArticleEligibleSql("a")} AS commande_client_eligible,
         ${commandeArticleIneligibilityCodeSql("a")} AS commande_client_ineligibility_code,
         a.row_version::int AS row_version,
         a.archived_at::text AS archived_at,
         a.archive_reason,
         CASE WHEN av.id IS NULL THEN NULL ELSE jsonb_build_object(
           'id', av.id::text,
           'indice', av.indice,
           'statut', av.statut,
           'plan_reference', av.plan_reference,
           'date_application', av.date_application,
           'manufacturing_mode', av.manufacturing_mode,
           'assembly_supply_strategy', av.assembly_supply_strategy
         ) END AS applicable_version,
         a.notes,
         (SELECT jsonb_build_object('piece_technique_id', t.piece_technique_id,
           'piece_technique_version_id', t.piece_technique_version_id, 'finish_revision_id', t.finish_revision_id)
           FROM public.articles_traitement t WHERE t.article_id = a.id) AS finish_definition,
         CASE
           WHEN ${normalizedArticleCategorySql("a.article_category")} <> 'matiere' THEN NULL
           WHEN am.article_id IS NULL THEN NULL
           ELSE jsonb_build_object(
             'nuance_id', am.nuance_id,
             'etat_id', am.etat_id,
             'sous_etat_id', am.sous_etat_id,
             'client_proprietaire_id', to_jsonb(am) ->> 'client_proprietaire_id',
             'barre_a_decouper', am.barre_a_decouper,
             'longueur_barre_source_mm', NULLIF(to_jsonb(am) ->> 'longueur_barre_source_mm', '')::int,
             'longueur_coupe_mm', NULLIF(to_jsonb(am) ->> 'longueur_coupe_mm', '')::int,
             'longueur_brut_mm', COALESCE(
               NULLIF(to_jsonb(am) ->> 'longueur_brut_mm', '')::int,
               am.longueur_mm
             ),
             'quantite_lineaire_totale_mm', NULLIF(to_jsonb(am) ->> 'quantite_lineaire_totale_mm', '')::float8,
             'longueur_mm', am.longueur_mm,
             'longueur_unitaire_mm', am.longueur_unitaire_mm,
             'largeur_mm', am.largeur_mm,
             'hauteur_mm', am.hauteur_mm,
             'epaisseur_mm', am.epaisseur_mm,
             'diametre_mm', am.diametre_mm,
             'largeur_plat_mm', am.largeur_plat_mm
           )
         END AS article_matiere,
         CASE
           WHEN ${normalizedArticleCategorySql("a.article_category")} <> 'achat' OR aa.article_id IS NULL THEN NULL
           WHEN aa.reference_client IS NULL OR aa.numero_client IS NULL THEN NULL
           ELSE jsonb_build_object(
             'reference', aa.reference_client,
             'indice', aa.indice_client,
             'numero_client', aa.numero_client
           )
         END AS fourniture_client,
         COALESCE(bs.qty_available, 0)::float8 AS qty_available,
         COALESCE(bs.qty_reserved, 0)::float8 AS qty_reserved,
         COALESCE(bs.qty_total, 0)::float8 AS qty_total,
         COALESCE(lots_available.available_lots_count, 0)::int AS available_lots_count,
         COALESCE(bs.locations_count, 0)::int AS locations_count,
         a.updated_at::text AS updated_at,
         a.created_at::text AS created_at
       FROM public.articles a
       LEFT JOIN public.pieces_techniques pt
         ON pt.id = a.piece_technique_id
       LEFT JOIN public.clients piece_client ON piece_client.client_id = pt.client_id
       LEFT JOIN public.articles_matiere am
         ON am.article_id = a.id
       LEFT JOIN public.articles_achat aa
         ON aa.article_id = a.id
       LEFT JOIN LATERAL (
         SELECT v.id, v.indice, v.statut, v.plan_reference, v.date_application::text AS date_application,
                v.manufacturing_mode, v.assembly_supply_strategy
         FROM public.piece_technique_versions v
         WHERE v.piece_technique_id = a.piece_technique_id
           AND v.statut = 'APPLICABLE'
         ORDER BY v.date_application DESC NULLS LAST, v.created_at DESC
         LIMIT 1
       ) av ON TRUE
       LEFT JOIN LATERAL (
         SELECT v.indice, v.plan_reference
         FROM public.piece_technique_versions v
         WHERE v.piece_technique_id = a.piece_technique_id
         ORDER BY v.is_current DESC, v.version_interne DESC, v.created_at DESC
         LIMIT 1
       ) latest_version ON TRUE
       LEFT JOIN (
         SELECT
           article_id::text AS article_id,
           COUNT(*)::int AS locations_count,
           COALESCE(SUM(qty_available), 0)::float8 AS qty_available,
           COALESCE(SUM(qty_reserved), 0)::float8 AS qty_reserved,
           COALESCE(SUM(qty_total), 0)::float8 AS qty_total
        FROM public.v_stock_availability_225
        GROUP BY article_id
      ) bs ON bs.article_id = a.id::text
      LEFT JOIN (
        SELECT article_id::text AS article_id, COUNT(DISTINCT lot_id)::int AS available_lots_count
        FROM public.v_stock_availability_225
        WHERE lot_id IS NOT NULL AND qty_available > 0
        GROUP BY article_id
      ) lots_available ON lots_available.article_id = a.id::text
      LEFT JOIN LATERAL (
        SELECT array_agg(acl.category_code ORDER BY acl.is_primary DESC, acl.category_code ASC)::text[] AS categories
        FROM public.article_category_link acl
        WHERE acl.article_id = a.id
      ) ac ON TRUE
      WHERE a.id = $1::uuid
    `,
    [id]
  );
  const article = res.rows[0] ?? null;
  if (!article) return null;

  const isMaterialArticle =
    article.article_category === "matiere" ||
    (Array.isArray(article.article_categories) && article.article_categories.includes("matiere_premiere"));

  const openSupplierOrdersPromise = isMaterialArticle || article.article_categories?.includes("consommable")
    ? db.query<{
        order_id: string;
        order_code: string;
        order_status: StockArticleDetail["open_supplier_orders"][number]["order_status"];
        supplier_id: string;
        supplier_code: string | null;
        supplier_name: string;
        line_id: string;
        line_position: number;
        ordered_quantity: string;
        received_quantity: string;
        remaining_quantity: string;
        unit: string | null;
        need_date: string | null;
        promised_date: string | null;
        lead_time_days: number | null;
        of_allocations: StockArticleDetail["open_supplier_orders"][number]["of_allocations"] | null;
      }>(
        `SELECT
           cf.id::text AS order_id,
           cf.code AS order_code,
           cf.statut AS order_status,
           f.id::text AS supplier_id,
           COALESCE(f.code, f.code_fournisseur)::text AS supplier_code,
           COALESCE(f.nom, f.raison_sociale)::text AS supplier_name,
           cfl.id::text AS line_id,
           cfl.position::int AS line_position,
           cfl.quantite::text AS ordered_quantity,
           COALESCE(receipts.received_quantity, 0)::text AS received_quantity,
           GREATEST(cfl.quantite - cfl.qty_annulee - COALESCE(receipts.received_quantity, 0), 0)::text
             AS remaining_quantity,
           cfl.unite AS unit,
           COALESCE(cfl.date_besoin, cf.date_besoin)::text AS need_date,
           COALESCE(cfl.date_promesse, cf.date_promesse)::text AS promised_date,
           cfl.delai_jours::int AS lead_time_days,
           COALESCE(allocations.items, '[]'::jsonb) AS of_allocations
         FROM public.commande_fournisseur_ligne cfl
         JOIN public.commande_fournisseur cf ON cf.id = cfl.commande_id
         JOIN public.fournisseurs f ON f.id = cf.fournisseur_id
         LEFT JOIN LATERAL (
           SELECT COALESCE(SUM(reception_line.qty_received), 0) AS received_quantity
           FROM public.reception_fournisseur_lignes reception_line
           WHERE reception_line.commande_fournisseur_ligne_id = cfl.id
         ) receipts ON TRUE
         LEFT JOIN LATERAL (
           SELECT jsonb_agg(
             jsonb_build_object(
               'of_id', source.of_id,
               'of_number', source.of_number,
               'allocated_quantity', source.allocated_quantity
             )
             ORDER BY source.of_number NULLS LAST, source.of_id
           ) AS items
           FROM (
             SELECT
               need.of_id,
               fabrication_order.numero AS of_number,
               SUM(need.quantite_couverte)::float8 AS allocated_quantity
             FROM public.commande_fournisseur_ligne_besoin need
             LEFT JOIN public.ordres_fabrication fabrication_order ON fabrication_order.id = need.of_id
             WHERE need.ligne_id = cfl.id
               AND NOT need.annule
               AND need.of_id IS NOT NULL
             GROUP BY need.of_id, fabrication_order.numero

             UNION ALL

             SELECT
               cfl.of_id,
               direct_order.numero AS of_number,
               NULL::float8 AS allocated_quantity
             FROM public.ordres_fabrication direct_order
             WHERE direct_order.id = cfl.of_id
               AND cfl.of_id IS NOT NULL
               AND NOT EXISTS (
                 SELECT 1
                 FROM public.commande_fournisseur_ligne_besoin existing_need
                 WHERE existing_need.ligne_id = cfl.id
                   AND NOT existing_need.annule
                   AND existing_need.of_id = cfl.of_id
               )
           ) source
         ) allocations ON TRUE
         WHERE cfl.article_id = $1::uuid
           AND cfl.statut_ligne = 'ACTIVE'
           AND cf.statut IN ('APPROUVEE', 'ENVOYEE', 'ACCUSE_RECU', 'PARTIELLEMENT_RECUE')
           AND GREATEST(cfl.quantite - cfl.qty_annulee - COALESCE(receipts.received_quantity, 0), 0) > 0
         ORDER BY COALESCE(cfl.date_promesse, cf.date_promesse) ASC NULLS LAST, cf.code ASC, cfl.position ASC`,
        [id]
      )
    : Promise.resolve({ rows: [] });

  const financialAnalysisPromise = includeCosts && article.piece_technique_id
    ? (async (): Promise<StockArticleDetail["financial_analysis"]> => {
        const [workOrdersResult, invoicedResult] = await Promise.all([
          db.query<{
            of_id: number;
            of_number: string;
            produced_quantity: number;
          }>(
            `SELECT fabrication.id::int AS of_id,
                    fabrication.numero::text AS of_number,
                    SUM(receipt.qty_ok)::float8 AS produced_quantity
               FROM public.of_receipts receipt
               JOIN public.ordres_fabrication fabrication ON fabrication.id = receipt.of_id
              WHERE fabrication.piece_technique_id = $1::uuid
                AND receipt.qty_ok > 0
              GROUP BY fabrication.id, fabrication.numero
              ORDER BY fabrication.id`,
            [article.piece_technique_id]
          ),
          db.query<{ delivered_quantity: number; delivered_revenue_ht: number }>(
            `SELECT COALESCE(SUM(source.quantity_consumed), 0)::float8 AS delivered_quantity,
                    COALESCE(SUM(source.amount_ex_tax), 0)::float8 AS delivered_revenue_ht
               FROM public.facture_source_allocations source
               JOIN public.bon_livraison_ligne delivery_line
                 ON source.source_type = 'DELIVERY_LINE'
                AND source.source_line_id = delivery_line.id::text
               JOIN public.commande_ligne line ON line.id = delivery_line.commande_ligne_id
              WHERE line.article_id = $1::uuid
                AND source.allocation_status = 'CONSUMED'`,
            [id]
          ),
        ]);

        const scopeResults = await Promise.all(workOrdersResult.rows.map(async (workOrder) => {
          const identity = await repoLoadScopeIdentity("OF", String(workOrder.of_id));
          if (!identity) {
            return {
              of_id: workOrder.of_id,
              of_number: workOrder.of_number,
              produced_quantity: Number(workOrder.produced_quantity),
              cost_total_ht: null,
              actual_hours: 0,
              reliability: "PARTIAL" as const,
              missing_inputs: ["Périmètre OF introuvable dans le moteur de marge."],
            };
          }
          const input = await repoBuildCalculationInput(identity, "ACTUAL", new Intl.DateTimeFormat("en-CA", {
            timeZone: "Europe/Paris",
          }).format(new Date()));
          const calculation = calculateMargin(input);
          const costMissing = calculation.missing_inputs.filter((missing) => missing.category !== "REVENUE");
          return {
            of_id: workOrder.of_id,
            of_number: workOrder.of_number,
            produced_quantity: Number(workOrder.produced_quantity),
            cost_total_ht: calculation.cost_total_ht == null ? null : Number(calculation.cost_total_ht),
            actual_hours: Number(calculation.measurements.actual_hours ?? 0),
            reliability: calculation.reliability,
            missing_inputs: costMissing.map((missing) => missing.message),
          };
        }));

        const coveredScopes = scopeResults.filter((scope) => scope.cost_total_ht !== null && scope.missing_inputs.length === 0);
        const allCostsCovered = scopeResults.length > 0 && coveredScopes.length === scopeResults.length;
        const producedQuantity = scopeResults.reduce((sum, scope) => sum + scope.produced_quantity, 0);
        const actualHours = scopeResults.reduce((sum, scope) => sum + scope.actual_hours, 0);
        const actualCostTotal = allCostsCovered
          ? scopeResults.reduce((sum, scope) => sum + (scope.cost_total_ht ?? 0), 0)
          : null;
        const deliveredQuantity = Number(invoicedResult.rows[0]?.delivered_quantity ?? 0);
        const deliveredRevenueHt = Number(invoicedResult.rows[0]?.delivered_revenue_ht ?? 0);
        const missingInputs = scopeResults.flatMap((scope) =>
          scope.missing_inputs.map((message) => `${scope.of_number} : ${message}`)
        );
        if (scopeResults.length === 0) missingInputs.push("Aucun OF réceptionné pour cet article.");
        if (deliveredQuantity <= 0) missingInputs.push("Aucune ligne de livraison facturée pour cet article.");

        return {
          method: "MARGIN_ENGINE_ACTUAL_OF_WEIGHTED",
          currency: article.sale_price_currency || "EUR",
          completed_work_orders: scopeResults.length,
          covered_work_orders: coveredScopes.length,
          produced_quantity: producedQuantity,
          actual_hours: actualHours,
          actual_cost_total_ht: actualCostTotal,
          average_actual_cost_per_unit: actualCostTotal !== null && producedQuantity > 0
            ? actualCostTotal / producedQuantity
            : null,
          delivered_quantity: deliveredQuantity,
          delivered_revenue_ht: deliveredRevenueHt,
          average_invoiced_unit_price: deliveredQuantity > 0 && deliveredRevenueHt > 0
            ? deliveredRevenueHt / deliveredQuantity
            : null,
          coverage_complete: allCostsCovered && deliveredQuantity > 0 && deliveredRevenueHt > 0,
          missing_inputs: missingInputs,
          work_order_scopes: scopeResults.map(({ actual_hours: _actualHours, ...scope }) => scope),
          calculated_at: new Date().toISOString(),
        };
      })()
    : Promise.resolve(null);

  const [procurementRes, suppliersRes, documents, openSupplierOrdersRes, financialResult] = await Promise.all([
    db.query<NonNullable<StockArticleDetail["procurement"]>>(
      `SELECT
         manufacturer_name,
         manufacturer_reference,
         preferred_catalogue_id::text AS preferred_catalogue_id,
         packaging,
         process,
         finish,
         requirements,
         certificate_required,
         min_stock::float8 AS min_stock,
         max_stock::float8 AS max_stock
       FROM public.article_procurement_profile
       WHERE article_id = $1::uuid`,
      [id]
    ),
    db.query<StockArticleDetail["suppliers"][number]>(
      `SELECT
         fc.id::text AS catalogue_id,
         f.id::text AS supplier_id,
         COALESCE(f.code, f.code_fournisseur)::text AS supplier_code,
         COALESCE(f.nom, f.raison_sociale)::text AS supplier_name,
         fc.reference_fournisseur AS supplier_reference,
         fc.unite AS unit,
         CASE WHEN $2::boolean THEN fc.prix_unitaire::float8 ELSE NULL END AS unit_price,
         COALESCE(to_jsonb(fc) ->> 'pricing_basis', 'NONE') AS pricing_basis,
         CASE WHEN $2::boolean THEN fc.devise ELSE NULL END AS currency,
         fc.delai_jours::int AS lead_time_days,
         fc.moq::float8 AS moq,
         fc.lot_achat::float8 AS lot_achat, fc.unite_stock AS stock_unit, fc.coef_conversion::float8 AS conversion_coefficient,
         fc.updated_at::text AS catalogue_updated_at,
         CASE WHEN $2::boolean THEN (to_jsonb(fc)->>'forfait_ht')::float8 ELSE NULL END AS forfait_ht,
         CASE WHEN $2::boolean THEN (to_jsonb(fc)->>'minimum_facturation_ht')::float8 ELSE NULL END AS minimum_facturation_ht,
         CASE WHEN $2::boolean THEN COALESCE(to_jsonb(fc)->'price_tiers','[]'::jsonb) ELSE '[]'::jsonb END AS price_tiers,
         fc.conditions,
         (app.preferred_catalogue_id = fc.id) AS preferred,
         fc.actif AS active
       FROM public.fournisseur_catalogue fc
       JOIN public.fournisseurs f ON f.id = fc.fournisseur_id
       LEFT JOIN public.article_procurement_profile app ON app.article_id = fc.article_id
       WHERE fc.article_id = $1::uuid
       ORDER BY (app.preferred_catalogue_id = fc.id) DESC, fc.actif DESC, supplier_name ASC`,
      [id, includeCosts]
    ),
    repoListArticleDocuments(id),
    openSupplierOrdersPromise,
    financialAnalysisPromise,
  ]);

  const financialAnalysis = financialResult;

  return {
    ...article,
    subcontract_definition: (await db.query(`SELECT s.*,p.code_piece AS piece_reference,p.designation AS piece_designation,v.indice
      FROM public.article_subcontract_definition s JOIN public.pieces_techniques p ON p.id=s.piece_technique_id
      JOIN public.piece_technique_versions v ON v.id=s.piece_technique_version_id WHERE s.article_id=$1::uuid`,[id])).rows[0]??null,
    procurement: procurementRes.rows[0] ?? null,
    suppliers: suppliersRes.rows,
    open_supplier_orders: openSupplierOrdersRes.rows.map((row) => ({
      ...row,
      line_position: Number(row.line_position),
      ordered_quantity: Number(row.ordered_quantity),
      received_quantity: Number(row.received_quantity),
      remaining_quantity: Number(row.remaining_quantity),
      lead_time_days: row.lead_time_days == null ? null : Number(row.lead_time_days),
      of_allocations: Array.isArray(row.of_allocations)
        ? row.of_allocations.map((allocation) => ({
            of_id: Number(allocation.of_id),
            of_number: allocation.of_number,
            allocated_quantity:
              allocation.allocated_quantity == null ? null : Number(allocation.allocated_quantity),
          }))
        : [],
    })),
    documents: documents ?? [],
    costs_redacted: !includeCosts,
    financial_analysis: financialAnalysis,
  };
}

/** Paged, authoritative lot detail for the article list drawer. */
export async function repoListAvailableArticleLots(
  articleId: string,
  filters: { page: number; limit: number }
): Promise<Paginated<StockAvailableLotItem> | null> {
  const exists = await db.query<{ ok: number }>(
    `SELECT 1::int AS ok FROM public.articles WHERE id = $1::uuid`,
    [articleId]
  );
  if (!exists.rows[0]?.ok) return null;
  const offset = (filters.page - 1) * filters.limit;
  const base = `
    FROM public.v_stock_availability_225 v
    JOIN public.lots l ON l.id = v.lot_id
    LEFT JOIN public.emplacements e ON e.location_id = v.location_id
    LEFT JOIN public.magasins m ON m.id = e.magasin_id
    LEFT JOIN LATERAL (
      SELECT ofx.numero::text AS of_number
      FROM public.of_output_lots ool
      JOIN public.ordres_fabrication ofx ON ofx.id = ool.of_id
      WHERE ool.lot_id = l.id
      ORDER BY ool.updated_at DESC, ool.id DESC
      LIMIT 1
    ) of_link ON TRUE
    WHERE v.article_id = $1::uuid AND v.lot_id IS NOT NULL AND v.qty_available > 0
  `;
  const count = await db.query<{ total: number }>(`SELECT COUNT(*)::int AS total ${base}`, [articleId]);
  const data = await db.query<StockAvailableLotItem>(`
    SELECT l.id::text AS lot_id,
           CASE
             WHEN l.origin_stock_scope = 'OLD' THEN 'OLD'
             ELSE COALESCE(l.source_scope, l.stock_scope, 'NEW')
           END::text AS source_scope,
           l.lot_code,
           v.qty_total::float8 AS qty_total,
           v.qty_reserved::float8 AS qty_reserved,
           v.qty_available::float8 AS qty_available,
           COALESCE(m.code, m.code_magasin)::text AS magasin_code,
           e.code AS emplacement_code,
           of_link.of_number, l.mp_reference, l.tr_reference,
           COALESCE(l.received_at, l.manufactured_at, l.created_at::date)::text AS fifo_received_at,
           l.created_at::text AS created_at
    ${base}
    ORDER BY CASE
               WHEN l.origin_stock_scope = 'OLD' THEN 0
               WHEN COALESCE(l.source_scope, l.stock_scope, 'NEW') = 'OLD' THEN 0
               ELSE 1
             END,
             COALESCE(l.received_at, l.manufactured_at, l.created_at::date) ASC,
             l.created_at ASC, l.id ASC
    LIMIT $2 OFFSET $3
  `, [articleId, filters.limit, offset]);
  return { items: data.rows, total: count.rows[0]?.total ?? 0 };
}

export async function repoGetArticlesKpis(): Promise<StockArticleKpis> {
  const res = await db.query<StockArticleKpis>(
    `
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE is_active)::int AS active,
        COUNT(*) FILTER (WHERE lot_tracking)::int AS lot_tracked,
        COUNT(*) FILTER (WHERE stock_managed)::int AS stock_managed,
        COUNT(*) FILTER (WHERE ${normalizedArticleCategorySql("article_category")} = 'fabrique')::int AS fabricated,
        COUNT(*) FILTER (WHERE ${normalizedArticleCategorySql("article_category")} <> 'fabrique')::int AS purchased,
        COUNT(*) FILTER (WHERE ${normalizedArticleCategorySql("article_category")} = 'matiere')::int AS matiere,
        COUNT(*) FILTER (WHERE ${normalizedArticleCategorySql("article_category")} = 'traitement')::int AS treatment,
        COUNT(*) FILTER (WHERE ${normalizedArticleCategorySql("article_category")} = 'achat')::int AS achat
      FROM public.articles
    `
  );
  return (
    res.rows[0] ?? {
      total: 0,
      active: 0,
      lot_tracked: 0,
      stock_managed: 0,
      fabricated: 0,
      purchased: 0,
      matiere: 0,
      treatment: 0,
      achat: 0,
    }
  );
}

export type CreatedArticleSummary = {
  id: string;
  code: string;
  article_type: "PIECE_TECHNIQUE" | "PURCHASED";
  article_category: ArticleCategory;
  article_categories: ArticleBusinessCategory[];
  family_code: string;
  stock_managed: boolean;
  lot_tracking: boolean;
  designation: string;
  unite: string | null;
  status: ArticleWorkflowStatus;
  is_active: boolean;
};

/**
 * Enqueues a stock article's immutable creation snapshot inside its owning
 * transaction. Incidental historical-import rows remain excluded because only
 * explicit user-facing creation commands call this helper.
 */
export async function queueStockArticleCreationSnapshotTx(
  client: PoolClient,
  created: CreatedArticleSummary,
  actorUserId: number
): Promise<void> {
  const sourceRevision = await client.query<{ updated_at: string }>(
    `SELECT updated_at::text AS updated_at FROM public.articles WHERE id = $1::uuid FOR SHARE`,
    [created.id]
  );
  const updatedAt = sourceRevision.rows[0]?.updated_at;
  if (!updatedAt) throw new Error("STOCK_ARTICLE_CREATION_SOURCE_REVISION_MISSING");
  await queueCreationPdfArchive(client, buildStockArticleCreationSnapshotInput({
    id: created.id,
    code: created.code,
    designation: created.designation,
    articleType: created.article_type,
    articleCategory: created.article_category,
    familyCode: created.family_code,
    unit: created.unite,
    status: created.status,
    stockManaged: created.stock_managed,
    lotTracking: created.lot_tracking,
    isActive: created.is_active,
    sourceRevision: updatedAt,
    actorUserId,
  }));
}

/**
 * Création d'article DANS une transaction déjà ouverte par l'appelant.
 *
 * C'est le SEUL chemin de création d'article : `repoCreateArticle` s'appuie
 * dessus, et les modules qui doivent créer un article à l'intérieur de leur
 * propre commande transactionnelle (#210 — finitions) l'appellent directement
 * au lieu de dupliquer la normalisation, la codification et les liaisons.
 *
 * L'appelant reste responsable du BEGIN/COMMIT/ROLLBACK et de l'idempotence.
 */
export async function repoCreateArticleTx(
  client: PoolClient,
  body: CreateArticleBodyDTO,
  audit: AuditContext,
  identity?: { specialProcessCode: string }
): Promise<CreatedArticleSummary> {
  if (
    identity
    && (body.article_category !== "traitement"
      || !/^PS-[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(identity.specialProcessCode)
      || identity.specialProcessCode.length > 80)
  ) {
    throw new HttpError(422, "SPECIAL_PROCESS_CODE_INVALID", "Code de procédé spécial invalide.");
  }
  const normalized = await normalizeArticleState({
    article_type: body.article_type,
    article_category: body.article_category,
    article_categories: body.article_categories,
    family_code: body.family_code,
    version_number: 1,
    plan_index: 1,
    status: body.status,
    projet_id: body.projet_id ?? null,
    piece_technique_id: body.piece_technique_id ?? null,
    stock_managed: body.stock_managed,
    lot_tracking: body.lot_tracking,
    // The submitted code is non-authoritative. Keep legacy payloads compatible
    // while the final ART-{FAMILY}-{SEQ6} value is allocated below.
    code: "",
    designation: body.designation ?? "",
    client,
  });
  const canonicalUnit = await assertCanonicalArticleUnit(client,
    normalized.article_category === "matiere" ? materialManagementUnit(body.article_matiere?.barre_a_decouper) : body.unite
  );
  /**
   * Matière première : la référence est DÉRIVÉE de la configuration matière,
   * jamais séquencée. Deux matières identiques doivent porter la même
   * référence — c'est ce qui rend le doublon détectable au lieu d'être créé en
   * silence sous deux numéros différents.
   *
   * La désignation suit la même source : si l'écran n'en propose pas (une MP
   * n'a plus de champ Désignation), le serveur produit la forme canonique.
   * `articles.designation` n'est jamais rendue nullable pour arranger l'UI.
   */
  const material = normalized.article_category === "matiere"
    ? await (async () => {
        const input = await resolveMaterialCodeInput(client, {
          family_code: normalized.family_code,
          nuance_id: body.article_matiere?.nuance_id ?? null,
          etat_id: body.article_matiere?.etat_id ?? null,
          sous_etat_id: body.article_matiere?.sous_etat_id ?? null,
          client_proprietaire_id: body.article_matiere?.client_proprietaire_id ?? null,
          reference_suffix: body.article_matiere?.reference_suffix ?? null,
          dimensions: body.article_matiere ?? null,
        });
        const result = buildMaterialArticleCode(input);
        assertMaterialPreviewFresh(
          body.material_code_preview_hash,
          computeMaterialCodePreviewHash({ input, code: result.code, designation: result.designation })
        );
        return result;
      })()
    : null;

  const generatedCode = identity?.specialProcessCode ?? (normalized.article_category === "fabrique"
    ? normalized.code
    : material
      ? material.code
      : await generateArticleBusinessCode(client, normalized.family_code));

  const designation = (body.designation ?? "").trim() || material?.designation || "";
  if (!designation) {
    throw new HttpError(400, "INVALID_ARTICLE", "La désignation de l'article est obligatoire.");
  }

  if (normalized.piece_technique_id) {
    await ensurePieceTechniqueExists(client, normalized.piece_technique_id);
  }

  const articleId = crypto.randomUUID();

  const res = await client.query<{ id: string; updated_at: string }>(
    `
      INSERT INTO public.articles (
        id,
        code, designation, designation_secondary, article_type, article_category, family_code, stock_managed, piece_technique_id, unite,
        root_article_id, parent_article_id, version_number, plan_index, status, projet_id,
        lot_tracking, is_sold, is_active, notes,
        created_by, updated_by
      )
      VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9::uuid,$10,$11::uuid,$12::uuid,$13,$14,$15,$16,$17,$18,$19,$20,$21,$21)
      RETURNING id::text AS id, updated_at::text AS updated_at
    `,
    [
      articleId,
      generatedCode,
      designation,
      body.designation_secondary ?? null,
      normalized.article_type,
      normalized.article_category,
      normalized.family_code,
      normalized.stock_managed,
      normalized.piece_technique_id,
      canonicalUnit,
      articleId,
      null,
      normalized.version_number,
      normalized.plan_index,
      normalized.status,
      normalized.projet_id,
      normalized.lot_tracking,
      body.is_sold,
      body.is_active,
      body.notes ?? null,
      audit.user_id,
    ]
  );

  const createdRow = res.rows[0];
  const id = createdRow?.id;
  if (!id) throw new Error("Failed to create article");
  await syncArticleCategories(client, id, normalized.article_categories, audit.user_id);
  await syncConsumablePolicyTx(client, id, consumablePolicyPatch(body), normalized);
  await syncArticleCommercialTx(client, id, body, audit.user_id, true);

  await syncPieceTechniqueArticleLink(client, {
    article_id: id,
    previous_piece_technique_id: null,
    next_piece_technique_id: normalized.piece_technique_id,
  });

  await syncArticleSubtypeDetails(client, {
    article_id: id,
    category: normalized.article_category,
    family_code: normalized.family_code,
    piece_technique_id: normalized.piece_technique_id,
      article_matiere: body.article_matiere,
      fourniture_client: body.fourniture_client,
  });
  await syncArticleProcurementProfile(client, id, body.procurement, audit.user_id);
  await syncArticleSupplierConditionsTx(client, id, body.supplier_conditions, audit);
  await syncSubcontractDefinitionTx(client,id,body.subcontract_definition,audit.user_id);
  if (body.sale_price_reference != null) {
    await seedArticleSheetSalePriceTx(client, {
      article_id: id,
      price: body.sale_price_reference,
      actor_user_id: audit.user_id,
    });
  }

  await insertAuditLog(client, audit, {
    action: "stock.articles.create",
    entity_type: "articles",
    entity_id: id,
    details: {
      code: generatedCode,
      designation,
      article_type: normalized.article_type,
      article_category: normalized.article_category,
      article_categories: normalized.article_categories,
      family_code: normalized.family_code,
      version_number: normalized.version_number,
      plan_index: normalized.plan_index,
      status: normalized.status,
      projet_id: normalized.projet_id,
      stock_managed: normalized.stock_managed,
      is_sold: body.is_sold,
      unite: canonicalUnit,
      sale_price_reference: body.sale_price_reference ?? null,
    },
  });

  return {
    id,
    code: generatedCode,
    article_type: normalized.article_type,
    article_category: normalized.article_category,
    article_categories: normalized.article_categories,
    family_code: normalized.family_code,
    stock_managed: normalized.stock_managed,
    lot_tracking: normalized.lot_tracking,
    designation,
    unite: canonicalUnit,
    status: normalized.status,
    is_active: body.is_active,
  };
}

export async function repoCreateArticle(
  body: CreateArticleBodyDTO,
  audit: AuditContext,
  idempotencyKey?: string | null,
  includeCosts = false
): Promise<StockArticleDetail> {
  const client = await db.connect();
  const requestHash = crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex");
  try {
    await client.query("BEGIN");

    if (idempotencyKey) {
      const replay = await client.query<{ article_id: string; request_hash: string }>(
        `SELECT article_id::text AS article_id, request_hash
         FROM public.article_create_idempotence
         WHERE idempotency_key = $1
         FOR UPDATE`,
        [idempotencyKey]
      );
      const existing = replay.rows[0];
      if (existing) {
        if (existing.request_hash !== requestHash) {
          throw new HttpError(409, "IDEMPOTENCY_KEY_REUSED", "Idempotency-Key was reused with a different Article payload.");
        }
        await client.query("ROLLBACK");
        const replayed = await repoGetArticle(existing.article_id, includeCosts);
        if (!replayed) throw new Error("Failed to read idempotent Article replay");
        return replayed;
      }
    }

    const created = await repoCreateArticleTx(client, body, audit);
    const id = created.id;

    if (idempotencyKey) {
      await client.query(
        `INSERT INTO public.article_create_idempotence (idempotency_key, request_hash, article_id)
         VALUES ($1,$2,$3::uuid)`,
        [idempotencyKey, requestHash, id]
      );
    }

    await queueStockArticleCreationSnapshotTx(client, created, audit.user_id);

    await client.query("COMMIT");

    const out = await repoGetArticle(id, includeCosts);
    if (!out) throw new Error("Failed to read created article");

    return out;
  } catch (err) {
    await client.query("ROLLBACK");
    if (idempotencyKey && isPgUniqueViolation(err)) {
      const replay = await db.query<{ article_id: string; request_hash: string }>(
        `SELECT article_id::text AS article_id, request_hash
         FROM public.article_create_idempotence
         WHERE idempotency_key = $1`,
        [idempotencyKey]
      );
      const existing = replay.rows[0];
      if (existing) {
        if (existing.request_hash !== requestHash) {
          throw new HttpError(409, "IDEMPOTENCY_KEY_REUSED", "Idempotency-Key was reused with a different Article payload.");
        }
        const replayed = await repoGetArticle(existing.article_id, includeCosts);
        if (replayed) return replayed;
      }
    }
    if (isPgUniqueViolation(err)) {
      /**
       * Matière : deux configurations identiques produisent volontairement la
       * MÊME référence. La collision n'est donc pas un incident technique, c'est
       * l'article qui existe déjà — on le dit, avec de quoi agir, au lieu
       * d'inventer un suffixe qui créerait un doublon silencieux.
       */
      if (body.article_category === "matiere") {
        const existing = await repoFindArticleByMaterialConfiguration(body);
        throw new HttpError(
          409,
          "DUPLICATE_MATERIAL_ARTICLE",
          existing
            ? `Cette matière existe déjà sous la référence ${existing.code}. Réutilisez-la, ou précisez la configuration (dimensions, sous-état) pour créer une matière distincte.`
            : "Cette référence matière existe déjà. Précisez la configuration pour créer une matière distincte."
        );
      }
      throw new HttpError(409, "DUPLICATE", "Article code already exists");
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Retrouve l'article matière qui occupe déjà la référence calculée, pour
 * pouvoir le nommer dans le message d'erreur. Toute défaillance de cette
 * lecture d'agrément reste silencieuse : elle ne doit jamais masquer le 409.
 */
async function repoFindArticleByMaterialConfiguration(
  body: CreateArticleBodyDTO
): Promise<{ id: string; code: string } | null> {
  try {
    const input = await resolveMaterialCodeInput(db, {
      family_code: body.family_code,
      nuance_id: body.article_matiere?.nuance_id ?? null,
      etat_id: body.article_matiere?.etat_id ?? null,
      sous_etat_id: body.article_matiere?.sous_etat_id ?? null,
      client_proprietaire_id: body.article_matiere?.client_proprietaire_id ?? null,
      reference_suffix: body.article_matiere?.reference_suffix ?? null,
      dimensions: body.article_matiere ?? null,
    });
    const { code } = buildMaterialArticleCode(input);
    const res = await db.query<{ id: string; code: string }>(
      `SELECT id::text AS id, code FROM public.articles WHERE code = $1 LIMIT 1`,
      [code]
    );
    return res.rows[0] ?? null;
  } catch {
    return null;
  }
}

export async function repoUpdateArticle(
  id: string,
  patch: UpdateArticleBodyDTO,
  audit: AuditContext,
  includeCosts = false,
  transactionClient?: PoolClient
): Promise<StockArticleDetail | null> {
  const client = transactionClient ?? await db.connect();
  const sets: string[] = [];
  const values: unknown[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  try {
    if (!transactionClient) await client.query("BEGIN");

    const currentRes = await client.query<{
      id: string;
      code: string;
      designation: string;
      article_type: string;
      article_category: string;
      article_categories: string[] | null;
      root_article_id: string | null;
      version_number: number;
      plan_index: number;
      status: string;
      projet_id: number | null;
      family_code: string;
      piece_technique_id: string | null;
      stock_managed: boolean;
      lot_tracking: boolean;
      row_version: number;
      designation_secondary: string | null;
      is_sold: boolean;
      unite: string | null;
      barre_a_decouper: boolean | null;
    }>(
      `
        SELECT
          id::text AS id,
          code,
          designation,
          article_type,
          article_category,
          (
            SELECT array_agg(acl.category_code ORDER BY acl.is_primary DESC, acl.category_code ASC)::text[]
            FROM public.article_category_link acl
            WHERE acl.article_id = public.articles.id
          ) AS article_categories,
          root_article_id::text AS root_article_id,
          version_number::int AS version_number,
          plan_index::int AS plan_index,
          status,
          projet_id::int AS projet_id,
          family_code,
          piece_technique_id::text AS piece_technique_id,
          stock_managed,
          lot_tracking,
          row_version::int AS row_version,
          designation_secondary,
          is_sold,
          unite,
          (SELECT m.barre_a_decouper FROM public.articles_matiere m WHERE m.article_id = public.articles.id) AS barre_a_decouper
        FROM public.articles
        WHERE id = $1::uuid
        FOR UPDATE
      `,
      [id]
    );
    const current = currentRes.rows[0] ?? null;
    if (!current) {
      if (!transactionClient) await client.query("ROLLBACK");
      return null;
    }
    if (patch.expected_row_version !== current.row_version) {
      throw new HttpError(409, "ARTICLE_VERSION_CONFLICT", "The Article changed since it was loaded.", {
        expected_row_version: patch.expected_row_version,
        current_row_version: current.row_version,
      });
    }

    if (Object.prototype.hasOwnProperty.call(patch, "sale_price_reference")) {
      await applyArticleSheetSalePriceTx(client, {
        article_id: id,
        new_price: patch.sale_price_reference ?? null,
        confirm_overwrite: patch.confirm_sale_price_overwrite ?? false,
        reason: patch.sale_price_change_reason ?? null,
        actor_user_id: audit.user_id,
      });
    }

    const requestedCategory = patch.article_category ?? current.article_category;
    const requestedPieceTechniqueId =
      patch.piece_technique_id !== undefined
        ? patch.piece_technique_id
        : current.piece_technique_id;
    const fabricatedIdentityChanged =
      (current.article_category === "fabrique" || requestedCategory === "fabrique") &&
      (
        requestedCategory !== current.article_category ||
        requestedPieceTechniqueId !== current.piece_technique_id
      );
    if (fabricatedIdentityChanged) {
      throw new HttpError(
        409,
        "FABRICATED_ARTICLE_IDENTITY_IMMUTABLE",
        "La catégorie et la pièce technique liées à un article fabriqué sont immuables. Créez un nouvel article pour une autre identité technique."
      );
    }

    const normalized = await normalizeArticleState({
      article_type: patch.article_type ?? current.article_type,
      article_category: patch.article_category ?? current.article_category,
      article_categories: patch.article_categories ?? current.article_categories,
      family_code: patch.family_code ?? current.family_code,
      version_number: current.version_number,
      plan_index: current.plan_index,
      status: patch.status ?? current.status,
      projet_id: patch.projet_id !== undefined ? patch.projet_id : current.projet_id,
      piece_technique_id: patch.piece_technique_id !== undefined ? patch.piece_technique_id : current.piece_technique_id,
      stock_managed: patch.stock_managed ?? current.stock_managed,
      lot_tracking: patch.lot_tracking ?? current.lot_tracking,
      code: current.code ?? "",
      designation: patch.designation ?? current.designation,
      client,
      // Article business codes are immutable snapshots. A normal PATCH must
      // not depend on the current state of the linked technical piece.
      preserve_existing_code: true,
    });

    if (patch.article_matiere && normalized.article_category !== "matiere") {
      throw new HttpError(
        400,
        "INVALID_ARTICLE",
        "article_matiere is only allowed for article_category=matiere"
      );
    }

    if (current.stock_managed && !normalized.stock_managed) {
      await ensureArticleCanDisableStockManagement(client, id);
    }

    const canonicalUnit = normalized.article_category === "matiere"
      ? await assertCanonicalArticleUnit(client, materialManagementUnit(
          patch.article_matiere ? patch.article_matiere.barre_a_decouper : current.barre_a_decouper
        ))
      : patch.unite !== undefined
      ? await assertCanonicalArticleUnit(client, patch.unite)
      : undefined;

    if (patch.designation !== undefined) sets.push(`designation = ${push(patch.designation)}`);
    if (patch.designation_secondary !== undefined) sets.push(`designation_secondary = ${push(patch.designation_secondary)}`);
    sets.push(`article_type = ${push(normalized.article_type)}`);
    sets.push(`article_category = ${push(normalized.article_category)}`);
    sets.push(`version_number = ${push(normalized.version_number)}`);
    sets.push(`plan_index = ${push(normalized.plan_index)}`);
    sets.push(`status = ${push(normalized.status)}`);
    sets.push(`projet_id = ${push(normalized.projet_id)}::bigint`);
    sets.push(`family_code = ${push(normalized.family_code)}`);
    sets.push(`stock_managed = ${push(normalized.stock_managed)}`);
    sets.push(`piece_technique_id = ${push(normalized.piece_technique_id)}::uuid`);
    if (canonicalUnit !== undefined) sets.push(`unite = ${push(canonicalUnit)}`);
    sets.push(`lot_tracking = ${push(normalized.lot_tracking)}`);
    if (patch.is_sold !== undefined) sets.push(`is_sold = ${push(patch.is_sold)}`);
    if (patch.notes !== undefined) sets.push(`notes = ${push(patch.notes)}`);

    sets.push(`updated_at = now()`);
    sets.push(`updated_by = ${push(audit.user_id)}`);
    sets.push(`row_version = row_version + 1`);

    // Change tracking flags together with consumption mode, before the general
    // article UPDATE, so a valid GLOBAL_PACK -> NONE transition satisfies the DB constraint.
    await syncConsumablePolicyTx(client, id, consumablePolicyPatch(patch), normalized);

    const sql = `
      UPDATE public.articles
      SET ${sets.join(", ")}
      WHERE id = ${push(id)}::uuid
      RETURNING id::text AS id
    `;

    const res = await client.query<{ id: string }>(sql, values);
    const rowId = res.rows[0]?.id;
    if (!rowId) return null;

    await syncArticleCategories(client, id, normalized.article_categories, audit.user_id);
    await syncArticleCommercialTx(client, id, patch, audit.user_id);

    await syncPieceTechniqueArticleLink(client, {
      article_id: id,
      previous_piece_technique_id: current.piece_technique_id,
      next_piece_technique_id: normalized.piece_technique_id,
    });

    await syncArticleSubtypeDetails(client, {
      article_id: id,
      category: normalized.article_category,
      family_code: normalized.family_code,
      piece_technique_id: normalized.piece_technique_id,
      article_matiere: patch.article_matiere,
      fourniture_client: patch.fourniture_client,
    });
    await syncArticleProcurementProfile(client, id, patch.procurement, audit.user_id);
    await syncArticleSupplierConditionsTx(client, id, patch.supplier_conditions, audit);
    await syncSubcontractDefinitionTx(client,id,patch.subcontract_definition,audit.user_id);

    await insertAuditLog(client, audit, {
      action: "stock.articles.update",
      entity_type: "articles",
      entity_id: id,
      details: {
        before: current,
        after: { ...normalized, ...consumablePolicyPatch(patch), unite: canonicalUnit === undefined ? current.unite : canonicalUnit, designation_secondary: patch.designation_secondary ?? current.designation_secondary, is_sold: patch.is_sold ?? current.is_sold },
      },
    });

    if (!transactionClient) await client.query("COMMIT");

    // The outer command reads the final detail after its own commit.
    return transactionClient ? null : repoGetArticle(id, includeCosts);
  } catch (err) {
    if (!transactionClient) await client.query("ROLLBACK");
    if (isPgUniqueViolation(err)) {
      throw new HttpError(409, "DUPLICATE", "Article code already exists");
    }
    throw err;
  } finally {
    if (!transactionClient) client.release();
  }
}

export async function repoValidateArticle(
  id: string,
  body: { expected_row_version: number },
  audit: AuditContext,
  includeCosts = false
): Promise<StockArticleDetail | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const currentResult = await client.query<{
      status: string;
      row_version: number;
      article_category: string;
      finish_revision_id: string | null;
      piece_technique_id: string | null;
      piece_technique_version_id: string | null;
      generated_designation: string | null;
      generated_comment: string | null;
    }>(
      `SELECT
         a.status,
         a.row_version::int AS row_version,
         ${normalizedArticleCategorySql("a.article_category")} AS article_category,
         t.finish_revision_id::text AS finish_revision_id,
         t.piece_technique_id::text AS piece_technique_id,
         t.piece_technique_version_id::text AS piece_technique_version_id,
         t.generated_designation,
         t.generated_comment
       FROM public.articles a
       LEFT JOIN public.articles_traitement t ON t.article_id = a.id
       WHERE a.id = $1::uuid
       FOR UPDATE OF a`,
      [id]
    );
    const current = currentResult.rows[0];
    if (!current) {
      await client.query("ROLLBACK");
      return null;
    }
    if (current.row_version !== body.expected_row_version) {
      throw new HttpError(409, "ARTICLE_VERSION_CONFLICT", "L'article a été modifié depuis son chargement.");
    }
    if (current.status !== "EN_DEVIS") {
      throw new HttpError(409, "ARTICLE_NOT_DRAFT", "Seul un article brouillon peut être validé et mis en production.");
    }
    if (
      current.article_category === "traitement"
      && (
        !current.finish_revision_id
        || !current.piece_technique_id
        || !current.piece_technique_version_id
        || !current.generated_designation
        || !current.generated_comment
      )
    ) {
      throw new HttpError(
        422,
        "SURFACE_FINISH_ARTICLE_INCOMPLETE",
        "L'article de traitement doit conserver la finition, la PT/version et les textes générés avant sa mise en production."
      );
    }

    await client.query(
      `UPDATE public.articles
       SET status = 'VALIDE',
           row_version = row_version + 1,
           updated_at = now(),
           updated_by = $2
       WHERE id = $1::uuid`,
      [id, audit.user_id]
    );
    await insertAuditLog(client, audit, {
      action: "stock.articles.validate-and-release",
      entity_type: "articles",
      entity_id: id,
      details: {
        before: { status: current.status, row_version: current.row_version },
        after: { status: "VALIDE", row_version: current.row_version + 1 },
      },
    });
    await client.query("COMMIT");
    return repoGetArticle(id, includeCosts);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function repoListArticleVersions(
  articleId: string,
  filters: ListArticleVersionsQueryDTO
): Promise<Paginated<ArticleTechnicalVersion> | null> {
  const exists = await db.query<{ piece_technique_id: string | null }>(
    `SELECT piece_technique_id::text AS piece_technique_id FROM public.articles WHERE id = $1::uuid`,
    [articleId]
  );
  const article = exists.rows[0];
  if (!article) return null;
  if (!article.piece_technique_id) return { items: [], total: 0 };

  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 25;
  const offset = (page - 1) * pageSize;
  const count = await db.query<{ total: number }>(
    `SELECT COUNT(*)::int AS total
     FROM public.piece_technique_versions
     WHERE piece_technique_id = $1::uuid`,
    [article.piece_technique_id]
  );
  const rows = await db.query<ArticleTechnicalVersion>(
    `SELECT
       id::text AS id,
       indice,
       statut,
       plan_reference,
       date_application::text AS date_application,
       manufacturing_mode,
       assembly_supply_strategy
     FROM public.piece_technique_versions
     WHERE piece_technique_id = $1::uuid
     ORDER BY date_application DESC NULLS LAST, created_at DESC, id DESC
     LIMIT $2 OFFSET $3`,
    [article.piece_technique_id, pageSize, offset]
  );
  return { items: rows.rows, total: count.rows[0]?.total ?? 0 };
}

const ARTICLE_WHERE_USED_CTE = `
  WITH article_context AS (
    SELECT id, piece_technique_id
    FROM public.articles
    WHERE id = $1::uuid
  ), usages AS (
    SELECT
      CASE WHEN parent_version.statut = 'APPLICABLE' THEN 'PIECE_CURRENT' ELSE 'PIECE_HISTORICAL' END::text AS usage_type,
      bom.id::text AS usage_id,
      bom.parent_piece_technique_id::text AS parent_id,
      concat('Nomenclature ', COALESCE(parent_piece.code_piece, bom.parent_piece_technique_id::text)) AS label,
      bom.created_at::text AS occurred_at
    FROM public.pieces_techniques_nomenclature bom
    JOIN article_context ac ON bom.child_article_id = ac.id
    LEFT JOIN public.piece_technique_versions parent_version ON parent_version.id = bom.parent_piece_technique_version_id
    LEFT JOIN public.pieces_techniques parent_piece ON parent_piece.id = bom.parent_piece_technique_id

    UNION ALL
    SELECT 'QUOTE', dl.id::text, dl.devis_id::text,
      concat('Devis ', dl.devis_id::text, ' · ligne ', dl.id::text), NULL::text
    FROM public.devis_ligne dl JOIN article_context ac ON dl.article_id = ac.id

    UNION ALL
    SELECT 'CUSTOMER_ORDER', cl.id::text, cl.commande_id::text,
      concat('Commande client ', cl.commande_id::text, ' · ligne ', cl.id::text), NULL::text
    FROM public.commande_ligne cl JOIN article_context ac ON cl.article_id = ac.id

    UNION ALL
    SELECT 'SUPPLIER_ORDER', cfl.id::text, cfl.commande_id::text,
      concat('Commande fournisseur ', cfl.commande_id::text, ' · ligne ', cfl.position::text), cfl.created_at::text
    FROM public.commande_fournisseur_ligne cfl JOIN article_context ac ON cfl.article_id = ac.id

    UNION ALL
    SELECT 'WORK_ORDER', ofa.id::text, ofa.id::text,
      concat('OF ', ofa.numero), ofa.created_at::text
    FROM public.ordres_fabrication ofa JOIN article_context ac ON ofa.piece_technique_id = ac.piece_technique_id
    WHERE ac.piece_technique_id IS NOT NULL

    UNION ALL
    SELECT 'RECEIPT', rfl.id::text, rfl.reception_id::text,
      concat('Réception ', rfl.reception_id::text, ' · ligne ', rfl.line_no::text), rfl.created_at::text
    FROM public.reception_fournisseur_lignes rfl JOIN article_context ac ON rfl.article_id = ac.id

    UNION ALL
    SELECT 'LOT', l.id::text, NULL::text,
      concat('Lot ', l.lot_code), l.created_at::text
    FROM public.lots l JOIN article_context ac ON l.article_id::text = ac.id::text

    UNION ALL
    SELECT 'STOCK_MOVEMENT', sml.id::text, sml.movement_id::text,
      concat('Mouvement de stock ', sml.movement_id::text, ' · ligne ', sml.line_no::text), sml.created_at::text
    FROM public.stock_movement_lines sml JOIN article_context ac ON sml.article_id::text = ac.id::text

    UNION ALL
    SELECT 'DELIVERY', blla.id::text, blla.bon_livraison_ligne_id::text,
      concat('Livraison · ligne ', blla.bon_livraison_ligne_id::text), blla.created_at::text
    FROM public.bon_livraison_ligne_allocations blla JOIN article_context ac ON blla.article_id = ac.id
  )`;

export async function repoListArticleWhereUsed(
  articleId: string,
  filters: ListArticleWhereUsedQueryDTO
): Promise<Paginated<ArticleWhereUsedItem> | null> {
  const exists = await db.query<{ ok: number }>(`SELECT 1::int AS ok FROM public.articles WHERE id = $1::uuid`, [articleId]);
  if (!exists.rows[0]?.ok) return null;

  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 25;
  const offset = (page - 1) * pageSize;
  const usageType = filters.usage_type ?? null;
  const count = await db.query<{ total: number }>(
    `${ARTICLE_WHERE_USED_CTE}
     SELECT COUNT(*)::int AS total FROM usages WHERE ($2::text IS NULL OR usage_type = $2)`,
    [articleId, usageType]
  );
  const rows = await db.query<ArticleWhereUsedItem>(
    `${ARTICLE_WHERE_USED_CTE}
     SELECT usage_type, usage_id, parent_id, label, occurred_at
     FROM usages
     WHERE ($2::text IS NULL OR usage_type = $2)
     ORDER BY occurred_at DESC NULLS LAST, usage_type ASC, usage_id DESC
     LIMIT $3 OFFSET $4`,
    [articleId, usageType, pageSize, offset]
  );
  return { items: rows.rows, total: count.rows[0]?.total ?? 0 };
}

async function countArticleUsages(client: PoolClient, articleId: string): Promise<number> {
  const result = await client.query<{ total: number }>(
    `${ARTICLE_WHERE_USED_CTE} SELECT COUNT(*)::int AS total FROM usages`,
    [articleId]
  );
  return result.rows[0]?.total ?? 0;
}

export async function repoArchiveArticle(
  articleId: string,
  body: ArchiveArticleBodyDTO,
  audit: AuditContext,
  includeCosts = false
): Promise<StockArticleDetail | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const currentRes = await client.query<{ code: string; row_version: number; is_active: boolean }>(
      `SELECT code, row_version::int AS row_version, is_active
       FROM public.articles WHERE id = $1::uuid FOR UPDATE`,
      [articleId]
    );
    const current = currentRes.rows[0];
    if (!current) {
      await client.query("ROLLBACK");
      return null;
    }
    if (body.expected_row_version !== current.row_version) {
      throw new HttpError(409, "ARTICLE_VERSION_CONFLICT", "The Article changed since it was loaded.", {
        expected_row_version: body.expected_row_version,
        current_row_version: current.row_version,
      });
    }
    if (!current.is_active) {
      await client.query("COMMIT");
      return repoGetArticle(articleId, includeCosts);
    }
    const usageCount = await countArticleUsages(client, articleId);
    if (usageCount > 0) {
      throw new HttpError(409, "ARTICLE_IN_USE", "An Article referenced by business records cannot be archived.", {
        usage_count: usageCount,
      });
    }
    await client.query(
      `UPDATE public.articles
       SET is_active = false,
           archived_at = now(),
           archived_by = $2,
           archive_reason = $3,
           row_version = row_version + 1,
           updated_at = now(),
           updated_by = $2
       WHERE id = $1::uuid`,
      [articleId, audit.user_id, body.reason ?? null]
    );
    await insertAuditLog(client, audit, {
      action: "stock.articles.archive",
      entity_type: "articles",
      entity_id: articleId,
      details: { code: current.code, before: { is_active: true }, after: { is_active: false, reason: body.reason ?? null } },
    });
    await client.query("COMMIT");
    return repoGetArticle(articleId, includeCosts);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function repoReactivateArticle(
  articleId: string,
  body: ReactivateArticleBodyDTO,
  audit: AuditContext,
  includeCosts = false
): Promise<StockArticleDetail | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const currentRes = await client.query<{ code: string; row_version: number; is_active: boolean }>(
      `SELECT code, row_version::int AS row_version, is_active
       FROM public.articles WHERE id = $1::uuid FOR UPDATE`,
      [articleId]
    );
    const current = currentRes.rows[0];
    if (!current) {
      await client.query("ROLLBACK");
      return null;
    }
    if (body.expected_row_version !== current.row_version) {
      throw new HttpError(409, "ARTICLE_VERSION_CONFLICT", "The Article changed since it was loaded.", {
        expected_row_version: body.expected_row_version,
        current_row_version: current.row_version,
      });
    }
    if (current.is_active) {
      await client.query("COMMIT");
      return repoGetArticle(articleId, includeCosts);
    }
    await client.query(
      `UPDATE public.articles
       SET is_active = true,
           archived_at = NULL,
           archived_by = NULL,
           archive_reason = NULL,
           row_version = row_version + 1,
           updated_at = now(),
           updated_by = $2
       WHERE id = $1::uuid`,
      [articleId, audit.user_id]
    );
    await insertAuditLog(client, audit, {
      action: "stock.articles.reactivate",
      entity_type: "articles",
      entity_id: articleId,
      details: { code: current.code, before: { is_active: false }, after: { is_active: true } },
    });
    await client.query("COMMIT");
    return repoGetArticle(articleId, includeCosts);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
