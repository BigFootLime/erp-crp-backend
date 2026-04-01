import type { PoolClient } from "pg";
import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import db from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import type { CreateAuditLogBodyDTO } from "../../audit-logs/validators/audit-logs.validators";
import type {
  ArticleCategory,
  ArticleBusinessCategory,
  Paginated,
  StockAnalytics,
  StockArticleCategoryOption,
  StockArticleDetail,
  StockArticleFamily,
  StockArticleKpis,
  StockArticleListItem,
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
  StockLotListItem,
  StockMagasinDetail,
  StockMagasinKpis,
  StockMagasinListItem,
  StockMovementDetail,
  StockMovementEvent,
  StockMovementLineDetail,
  StockMovementListItem,
} from "../types/stock.types";
import type {
  ArticleCategoryDTO,
  CreateMatiereEtatBodyDTO,
  CreateMatiereNuanceBodyDTO,
  CreateMatiereSousEtatBodyDTO,
  CreateArticleBodyDTO,
  CreateArticleFamilyBodyDTO,
  CreateEmplacementBodyDTO,
  CreateInventorySessionBodyDTO,
  CreateLotBodyDTO,
  CreateMagasinBodyDTO,
  CreateMovementBodyDTO,
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
  UpdateArticleBodyDTO,
  UpdateEmplacementBodyDTO,
  UpdateLotBodyDTO,
  UpdateMagasinBodyDTO,
} from "../validators/stock.validators";

export type AuditContext = {
  user_id: number;
  ip: string | null;
  user_agent: string | null;
  device_type: string | null;
  os: string | null;
  browser: string | null;
  path: string | null;
  page_key: string | null;
  client_session_id: string | null;
};

const ARTICLE_PRIMARY_CATEGORY_OPTIONS: Array<{ code: ArticleCategory }> = [
  { code: "fabrique" },
  { code: "matiere" },
  { code: "traitement" },
  { code: "achat" },
];

const ARTICLE_CATEGORY_OPTIONS: StockArticleCategoryOption[] = [
  {
    code: "piece_finie_fabriquee",
    label: "Pièce finie / Fabriquée",
    code_segment: "PLAN",
    stock_managed_default: true,
    piece_technique_required: true,
    commande_client_selectable: true,
  },
  {
    code: "matiere_premiere",
    label: "Matière Première",
    code_segment: "MP",
    stock_managed_default: true,
    piece_technique_required: false,
    commande_client_selectable: false,
  },
  {
    code: "traitement_surface",
    label: "Traitement de Surface",
    code_segment: "TRT",
    stock_managed_default: false,
    piece_technique_required: false,
    commande_client_selectable: false,
  },
  {
    code: "achat_revente",
    label: "Achat-Revente",
    code_segment: "ACH",
    stock_managed_default: true,
    piece_technique_required: false,
    commande_client_selectable: false,
  },
  {
    code: "achat_transforme",
    label: "Achat-Transformé",
    code_segment: "AHT",
    stock_managed_default: true,
    piece_technique_required: false,
    commande_client_selectable: false,
  },
  {
    code: "sous_traitance",
    label: "Sous-traitance",
    code_segment: "STA",
    stock_managed_default: false,
    piece_technique_required: false,
    commande_client_selectable: false,
  },
];

const BUSINESS_TO_PRIMARY_CATEGORY: Record<ArticleBusinessCategory, ArticleCategory> = {
  piece_finie_fabriquee: "fabrique",
  matiere_premiere: "matiere",
  traitement_surface: "traitement",
  achat_revente: "achat",
  achat_transforme: "achat",
  sous_traitance: "achat",
};

type UploadedDocument = Express.Multer.File;

function isPgUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "23505";
}

function sortDirection(sortDir: "asc" | "desc" | undefined): "ASC" | "DESC" {
  return sortDir === "asc" ? "ASC" : "DESC";
}

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

async function insertAuditLog(
  tx: Pick<PoolClient, "query">,
  audit: AuditContext,
  entry: {
    action: string;
    entity_type: string | null;
    entity_id: string | null;
    details?: Record<string, unknown> | null;
  }
) {
  const body: CreateAuditLogBodyDTO = {
    event_type: "ACTION",
    action: entry.action,
    page_key: audit.page_key,
    entity_type: entry.entity_type,
    entity_id: entry.entity_id,
    path: audit.path,
    client_session_id: audit.client_session_id,
    details: entry.details ?? null,
  };

  await repoInsertAuditLog({
    user_id: audit.user_id,
    body,
    ip: audit.ip,
    user_agent: audit.user_agent,
    device_type: audit.device_type,
    os: audit.os,
    browser: audit.browser,
    tx,
  });
}

function normalizeLikeQuery(raw: string): string {
  return `%${raw.trim()}%`;
}

function isArticleCategory(value: string): value is ArticleCategory {
  return value === "fabrique" || value === "matiere" || value === "traitement" || value === "achat";
}

function isArticleBusinessCategory(value: string): value is ArticleBusinessCategory {
  return ARTICLE_CATEGORY_OPTIONS.some((item) => item.code === value);
}

function toBusinessArticleCategory(requested: string | null | undefined, fallback: ArticleCategory = "achat"): ArticleCategory {
  const value = typeof requested === "string" ? requested.trim() : "";
  if (!value) return fallback;

  const normalized = value.toLowerCase();
  if (isArticleCategory(normalized)) return normalized;

  const legacy = value.trim().toUpperCase();
  if (legacy === "PIECE_TECHNIQUE") return "fabrique";
  if (legacy === "MATIERE_PREMIERE") return "matiere";
  if (legacy === "TRAITEMENT") return "traitement";
  if (legacy === "FOURNITURE") return "achat";
  return fallback;
}

function defaultBusinessCategoryForPrimary(category: ArticleCategory): ArticleBusinessCategory {
  if (category === "fabrique") return "piece_finie_fabriquee";
  if (category === "matiere") return "matiere_premiere";
  if (category === "traitement") return "traitement_surface";
  return "achat_revente";
}

function inferArticleType(category: ArticleCategory): "PIECE_TECHNIQUE" | "PURCHASED" {
  return category === "fabrique" ? "PIECE_TECHNIQUE" : "PURCHASED";
}

function defaultFamilyCodeForCategory(category: ArticleCategory): string {
  if (category === "fabrique") return "PT";
  if (category === "matiere") return "MAT";
  if (category === "traitement") return "TRT";
  return "ACH";
}

const familyCodeAliasMap: Record<string, string> = {
  ROND: "RO",
  TUBE: "TU",
  TOLE: "TO",
  BARRE: "BA",
  PROFIL: "PR",
};

function normalizeFamilyCode(value: string | null | undefined, fallback: string): string {
  const raw = typeof value === "string" ? value.trim().toUpperCase() : "";
  const normalized = raw.replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function sanitizeCodeToken(value: string | null | undefined, fallback: string): string {
  const raw = typeof value === "string" ? value.trim().toUpperCase() : "";
  const normalized = raw.replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function normalizeFullArticleCode(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function normalizeArticleWorkflowStatus(value: string | null | undefined): "EN_DEVIS" | "VALIDE" {
  const normalized = typeof value === "string" ? value.trim().toUpperCase() : "";
  return normalized === "EN_DEVIS" ? "EN_DEVIS" : "VALIDE";
}

function normalizeArticleCategories(
  requested: string[] | null | undefined,
  primaryCategory: ArticleCategory
): ArticleBusinessCategory[] {
  const out: ArticleBusinessCategory[] = [];
  const push = (value: string | null | undefined) => {
    const raw = typeof value === "string" ? value.trim() : "";
    if (!raw) return;
    const normalized = raw.toLowerCase();
    if (isArticleBusinessCategory(normalized)) {
      if (!out.includes(normalized)) out.push(normalized);
      return;
    }
    if (isArticleCategory(normalized)) {
      const mapped = defaultBusinessCategoryForPrimary(normalized);
      if (!out.includes(mapped)) out.push(mapped);
      return;
    }
    throw new HttpError(400, "INVALID_ARTICLE_CATEGORY", `Unknown article category ${raw}`);
  };

  push(defaultBusinessCategoryForPrimary(primaryCategory));
  for (const value of requested ?? []) push(value);
  return out;
}

function derivePrimaryCategoryFromBusinessCategories(categories: ArticleBusinessCategory[]): ArticleCategory {
  if (categories.some((value) => BUSINESS_TO_PRIMARY_CATEGORY[value] === "fabrique")) return "fabrique";
  if (categories.some((value) => BUSINESS_TO_PRIMARY_CATEGORY[value] === "matiere")) return "matiere";
  if (categories.some((value) => BUSINESS_TO_PRIMARY_CATEGORY[value] === "traitement")) return "traitement";
  return "achat";
}

function expectedFabricatedArticleCodeFromPlan(planReference: string, planIndex: number): string {
  return `${sanitizeCodeToken(planReference, "PLAN")}-P${planIndex}`;
}

function categoryCodeSegment(category: ArticleCategory): string {
  if (category === "fabrique") return "PLAN";
  if (category === "matiere") return "MP";
  if (category === "traitement") return "TRT";
  return "ACH";
}

function familyCodeSegment(value: string | null | undefined): string {
  const normalized = normalizeFamilyCode(value, "GEN");
  const alias = familyCodeAliasMap[normalized];
  if (alias) return alias;
  return normalized.slice(0, 3);
}

async function getPieceTechniqueMetadata(
  client: Pick<PoolClient, "query">,
  pieceTechniqueId: string
): Promise<{ code_piece: string; designation: string; family_code: string | null }> {
  const res = await client.query<{ code_piece: string; designation: string; family_code: string | null }>(
    `
      SELECT
        pt.code_piece,
        pt.designation,
        pf.code AS family_code
      FROM public.pieces_techniques pt
      LEFT JOIN public.pieces_families pf ON pf.id = pt.famille_id
      WHERE pt.id = $1::uuid
      LIMIT 1
    `,
    [pieceTechniqueId]
  );
  const row = res.rows[0] ?? null;
  if (!row) {
    throw new HttpError(400, "INVALID_PIECE_TECHNIQUE", "Unknown piece_technique_id");
  }
  return row;
}

function buildSuggestedArticleCode(args: {
  category: ArticleCategory;
  family_code: string;
  final_segment: string;
}): string {
  if (args.category === "fabrique") {
    return sanitizeCodeToken(args.final_segment, "PLAN");
  }
  return `${categoryCodeSegment(args.category)}-${familyCodeSegment(args.family_code)}-${sanitizeCodeToken(args.final_segment, "GEN")}`;
}

async function resolveArticleCode(
  client: Pick<PoolClient, "query">,
  args: {
    code: string;
    designation: string;
    category: ArticleCategory;
    family_code: string;
    piece_technique_id: string | null;
    plan_index: number;
  }
): Promise<string> {
  const pieceMeta = args.piece_technique_id ? await getPieceTechniqueMetadata(client, args.piece_technique_id) : null;
  const finalSegment = args.category === "fabrique"
    ? sanitizeCodeToken(pieceMeta?.code_piece, "PLAN")
    : sanitizeCodeToken(args.code || args.designation, "GEN");
  const suggested = buildSuggestedArticleCode({
    category: args.category,
    family_code: args.family_code,
    final_segment: finalSegment,
  });

  if (args.category === "fabrique") {
    const expected = expectedFabricatedArticleCodeFromPlan(finalSegment, args.plan_index);
    const provided = args.code.trim();
    if (!provided) return expected;

    const normalized = normalizeFullArticleCode(provided);
    if (normalized !== expected) {
      throw new HttpError(
        400,
        "INVALID_FABRICATED_ARTICLE_CODE",
        `Fabricated article code must match plan reference with index (${expected})`
      );
    }
    return normalized;
  }

  const provided = args.code.trim();
  if (!provided) return suggested;

  const normalized = normalizeFullArticleCode(provided);
  return normalized;
}

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
}) {
  const categoryFromType = (() => {
    const articleType = typeof args.article_type === "string" ? args.article_type.trim().toUpperCase() : "";
    if (articleType === "PIECE_TECHNIQUE") return "fabrique" as const;
    if (articleType === "PURCHASED") return toBusinessArticleCategory(args.article_category, "achat");
    return toBusinessArticleCategory(args.article_category, "achat");
  })();
  const requestedPrimaryCategory = toBusinessArticleCategory(args.article_category, categoryFromType);
  const article_categories = normalizeArticleCategories(args.article_categories, requestedPrimaryCategory);
  const article_category = derivePrimaryCategoryFromBusinessCategories(article_categories);
  const article_type = inferArticleType(article_category);
  const piece_technique_id = article_category === "fabrique" ? args.piece_technique_id : null;
  const family_code = normalizeFamilyCode(args.family_code, defaultFamilyCodeForCategory(article_category));
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

  if (article_category === "fabrique" && !projet_id) {
    throw new HttpError(400, "INVALID_ARTICLE", "Fabricated articles require projet_id");
  }

  if (projet_id) {
    await ensureProjetAffaireExists(args.client, projet_id);
  }

  const code = await resolveArticleCode(args.client, {
    code: args.code,
    designation: args.designation,
    category: article_category,
    family_code,
    piece_technique_id,
    plan_index,
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

function articleFamilyTable(category: ArticleCategory): string {
  if (category === "fabrique") return "articles_fabrique_families";
  if (category === "matiere") return "articles_matiere_families";
  if (category === "traitement") return "articles_traitement_families";
  return "articles_achat_families";
}

function articleDetailTable(category: ArticleCategory): string {
  if (category === "fabrique") return "articles_fabrique";
  if (category === "matiere") return "articles_matiere";
  if (category === "traitement") return "articles_traitement";
  return "articles_achat";
}

export async function repoListArticleCategories(): Promise<StockArticleCategoryOption[]> {
  return ARTICLE_CATEGORY_OPTIONS;
}

export async function repoListArticleFamilies(
  filters: ListArticleFamiliesQueryDTO = {}
): Promise<StockArticleFamily[]> {
  const categories = filters.category ? [filters.category] : ARTICLE_PRIMARY_CATEGORY_OPTIONS.map((item) => item.code);
  const rows: StockArticleFamily[] = [];

  for (const category of categories) {
    const table = articleFamilyTable(category);
    const res = await db.query<StockArticleFamily>(
      `
        SELECT
          code,
          designation,
          $1::text AS category,
          is_active,
          created_at::text AS created_at,
          updated_at::text AS updated_at
        FROM public.${table}
        ORDER BY code ASC
      `,
      [category]
    );
    rows.push(...res.rows);
  }

  return rows;
}

export async function repoCreateArticleFamily(
  body: CreateArticleFamilyBodyDTO,
  audit: AuditContext
): Promise<StockArticleFamily> {
  const category = body.category;
  const table = articleFamilyTable(category);
  const code = normalizeFamilyCode(body.code, defaultFamilyCodeForCategory(category));

  let res;
  try {
    res = await db.query<StockArticleFamily>(
      `
        INSERT INTO public.${table} (code, designation)
        VALUES ($1, $2)
        RETURNING
          code,
          designation,
          $3::text AS category,
          is_active,
          created_at::text AS created_at,
          updated_at::text AS updated_at
      `,
      [code, body.designation.trim(), category]
    );
  } catch (err) {
    if (isPgUniqueViolation(err)) {
      throw new HttpError(409, "DUPLICATE_ARTICLE_FAMILY", `Family ${code} already exists for category ${category}`);
    }
    throw err;
  }

  const row = res.rows[0] ?? null;
  if (!row) {
    throw new Error("Failed to create article family");
  }

  await repoInsertAuditLog({
    user_id: audit.user_id,
    body: {
      event_type: "ACTION",
      action: "stock.article-families.create",
      page_key: audit.page_key,
      entity_type: "article_families",
      entity_id: `${category}:${row.code}`,
      path: audit.path,
      client_session_id: audit.client_session_id,
      details: { category, code: row.code, designation: row.designation },
    },
    ip: audit.ip,
    user_agent: audit.user_agent,
    device_type: audit.device_type,
    os: audit.os,
    browser: audit.browser,
  });

  return row;
}

function isPgForeignKeyViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "23503";
}

function normalizeStockReferentialCode(raw: string, kind: string): string {
  const normalized = raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  if (!normalized) {
    throw new HttpError(400, "INVALID_CODE", `${kind} code is invalid`);
  }
  return normalized;
}

function uniqPositiveInts(values: number[] | null | undefined): number[] {
  const out: number[] = [];
  for (const v of values ?? []) {
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n) || n <= 0) continue;
    const i = Math.trunc(n);
    if (!out.includes(i)) out.push(i);
  }
  return out;
}

async function insertNuanceEtatLinks(params: {
  tx: Pick<PoolClient, "query">;
  nuance_id: number;
  etat_ids: number[];
}) {
  const ids = uniqPositiveInts(params.etat_ids);
  for (const etatId of ids) {
    await params.tx.query(
      `
        INSERT INTO public.stock_nuance_etats (nuance_id, etat_id)
        VALUES ($1::bigint, $2::bigint)
        ON CONFLICT (nuance_id, etat_id) DO NOTHING
      `,
      [params.nuance_id, etatId]
    );
  }
}

async function insertEtatNuanceLinks(params: {
  tx: Pick<PoolClient, "query">;
  etat_id: number;
  nuance_ids: number[];
}) {
  const ids = uniqPositiveInts(params.nuance_ids);
  for (const nuanceId of ids) {
    await params.tx.query(
      `
        INSERT INTO public.stock_nuance_etats (nuance_id, etat_id)
        VALUES ($1::bigint, $2::bigint)
        ON CONFLICT (nuance_id, etat_id) DO NOTHING
      `,
      [nuanceId, params.etat_id]
    );
  }
}

export async function repoListMatiereNuances(filters: ListMatiereNuancesQueryDTO = {}): Promise<StockMatiereNuance[]> {
  const where: string[] = [];
  const values: unknown[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  const shouldFilterByEtat = await (async () => {
    if (typeof filters.etat_id !== "number" || !Number.isFinite(filters.etat_id)) return false;
    const check = await db.query<{ ok: number }>(
      `SELECT 1::int AS ok FROM public.stock_nuance_etats WHERE etat_id = $1::bigint LIMIT 1`,
      [filters.etat_id]
    );
    return Boolean(check.rows[0]?.ok);
  })();

  if (filters.q) {
    const q = `%${filters.q.trim()}%`;
    const p = push(q);
    where.push(`(n.code ILIKE ${p} OR n.designation ILIKE ${p})`);
  }
  if (typeof filters.is_active === "boolean") {
    where.push(`n.is_active = ${push(filters.is_active)}`);
  }
  if (shouldFilterByEtat && typeof filters.etat_id === "number" && Number.isFinite(filters.etat_id)) {
    where.push(
      `EXISTS (SELECT 1 FROM public.stock_nuance_etats ne2 WHERE ne2.nuance_id = n.id AND ne2.etat_id = ${push(filters.etat_id)}::bigint)`
    );
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const res = await db.query<{
    id: number;
    code: string;
    designation: string;
    densite: string | number | null;
    is_active: boolean;
    etat_ids: number[];
  }>(
    `
      SELECT
        n.id::int AS id,
        n.code,
        n.designation,
        n.densite,
        n.is_active,
        COALESCE(
          array_agg(ne.etat_id::int ORDER BY ne.etat_id) FILTER (WHERE ne.etat_id IS NOT NULL),
          ARRAY[]::int[]
        ) AS etat_ids
      FROM public.stock_nuances n
      LEFT JOIN public.stock_nuance_etats ne ON ne.nuance_id = n.id
      ${whereSql}
      GROUP BY n.id
      ORDER BY n.code ASC
    `,
    values
  );

  return res.rows.map((row) => ({
    id: row.id,
    code: row.code,
    designation: row.designation,
    densite: row.densite === null ? null : typeof row.densite === "number" ? row.densite : Number(row.densite),
    is_active: row.is_active,
    etat_ids: Array.isArray(row.etat_ids) ? row.etat_ids.filter((v) => typeof v === "number") : [],
  }));
}

export async function repoCreateMatiereNuance(body: CreateMatiereNuanceBodyDTO, audit: AuditContext): Promise<StockMatiereNuance> {
  const code = normalizeStockReferentialCode(body.code, "Nuance");
  const designation = body.designation.trim();
  const densite = body.densite ?? null;
  const is_active = body.is_active;
  const etat_ids = uniqPositiveInts(body.etat_ids);

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    let ins;
    try {
      ins = await client.query<{ id: number }>(
        `
          INSERT INTO public.stock_nuances (code, designation, densite, is_active)
          VALUES ($1,$2,$3,$4)
          RETURNING id::int AS id
        `,
        [code, designation, densite, is_active]
      );
    } catch (err) {
      if (isPgUniqueViolation(err)) {
        throw new HttpError(409, "DUPLICATE_NUANCE", `Nuance ${code} already exists`);
      }
      throw err;
    }

    const nuanceId = ins.rows[0]?.id;
    if (!nuanceId) throw new Error("Failed to create nuance");

    if (etat_ids.length) {
      try {
        await insertNuanceEtatLinks({ tx: client, nuance_id: nuanceId, etat_ids });
      } catch (err) {
        if (isPgForeignKeyViolation(err)) {
          throw new HttpError(400, "INVALID_ETAT", "One or more etat_ids are invalid");
        }
        throw err;
      }
    }

    await repoInsertAuditLog({
      user_id: audit.user_id,
      body: {
        event_type: "ACTION",
        action: "stock.matiere-nuances.create",
        page_key: audit.page_key,
        entity_type: "stock_nuances",
        entity_id: String(nuanceId),
        path: audit.path,
        client_session_id: audit.client_session_id,
        details: { code, designation, densite, is_active, etat_ids },
      },
      ip: audit.ip,
      user_agent: audit.user_agent,
      device_type: audit.device_type,
      os: audit.os,
      browser: audit.browser,
      tx: client,
    });

    await client.query("COMMIT");

    return {
      id: nuanceId,
      code,
      designation,
      densite: densite === null ? null : Number(densite),
      is_active,
      etat_ids,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function repoListMatiereEtats(filters: ListMatiereEtatsQueryDTO = {}): Promise<StockMatiereEtat[]> {
  const where: string[] = [];
  const values: unknown[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  const shouldFilterByNuance = await (async () => {
    if (typeof filters.nuance_id !== "number" || !Number.isFinite(filters.nuance_id)) return false;
    const check = await db.query<{ ok: number }>(
      `SELECT 1::int AS ok FROM public.stock_nuance_etats WHERE nuance_id = $1::bigint LIMIT 1`,
      [filters.nuance_id]
    );
    return Boolean(check.rows[0]?.ok);
  })();

  if (filters.q) {
    const q = `%${filters.q.trim()}%`;
    const p = push(q);
    where.push(`(e.code ILIKE ${p} OR e.designation ILIKE ${p})`);
  }
  if (typeof filters.is_active === "boolean") {
    where.push(`e.is_active = ${push(filters.is_active)}`);
  }
  if (shouldFilterByNuance && typeof filters.nuance_id === "number" && Number.isFinite(filters.nuance_id)) {
    where.push(
      `EXISTS (SELECT 1 FROM public.stock_nuance_etats ne2 WHERE ne2.etat_id = e.id AND ne2.nuance_id = ${push(filters.nuance_id)}::bigint)`
    );
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const res = await db.query<{
    id: number;
    code: string;
    designation: string;
    unite_achat: number;
    is_active: boolean;
    nuance_ids: number[];
  }>(
    `
      SELECT
        e.id::int AS id,
        e.code,
        e.designation,
        e.unite_achat::int AS unite_achat,
        e.is_active,
        COALESCE(
          array_agg(ne.nuance_id::int ORDER BY ne.nuance_id) FILTER (WHERE ne.nuance_id IS NOT NULL),
          ARRAY[]::int[]
        ) AS nuance_ids
      FROM public.stock_etats e
      LEFT JOIN public.stock_nuance_etats ne ON ne.etat_id = e.id
      ${whereSql}
      GROUP BY e.id
      ORDER BY e.code ASC
    `,
    values
  );

  return res.rows.map((row) => ({
    id: row.id,
    code: row.code,
    designation: row.designation,
    unite_achat: typeof row.unite_achat === "number" ? row.unite_achat : Number(row.unite_achat) || 3020,
    is_active: row.is_active,
    nuance_ids: Array.isArray(row.nuance_ids) ? row.nuance_ids.filter((v) => typeof v === "number") : [],
  }));
}

export async function repoCreateMatiereEtat(body: CreateMatiereEtatBodyDTO, audit: AuditContext): Promise<StockMatiereEtat> {
  const code = normalizeStockReferentialCode(body.code, "Etat");
  const designation = body.designation.trim();
  const unite_achat = typeof body.unite_achat === "number" && Number.isFinite(body.unite_achat) ? Math.trunc(body.unite_achat) : 3020;
  const is_active = body.is_active;
  const nuance_ids = uniqPositiveInts(body.nuance_ids);

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    let ins;
    try {
      ins = await client.query<{ id: number }>(
        `
          INSERT INTO public.stock_etats (code, designation, unite_achat, is_active)
          VALUES ($1,$2,$3,$4)
          RETURNING id::int AS id
        `,
        [code, designation, unite_achat, is_active]
      );
    } catch (err) {
      if (isPgUniqueViolation(err)) {
        throw new HttpError(409, "DUPLICATE_ETAT", `Etat ${code} already exists`);
      }
      throw err;
    }

    const etatId = ins.rows[0]?.id;
    if (!etatId) throw new Error("Failed to create etat");

    if (nuance_ids.length) {
      try {
        await insertEtatNuanceLinks({ tx: client, etat_id: etatId, nuance_ids });
      } catch (err) {
        if (isPgForeignKeyViolation(err)) {
          throw new HttpError(400, "INVALID_NUANCE", "One or more nuance_ids are invalid");
        }
        throw err;
      }
    }

    await repoInsertAuditLog({
      user_id: audit.user_id,
      body: {
        event_type: "ACTION",
        action: "stock.matiere-etats.create",
        page_key: audit.page_key,
        entity_type: "stock_etats",
        entity_id: String(etatId),
        path: audit.path,
        client_session_id: audit.client_session_id,
        details: { code, designation, unite_achat, is_active, nuance_ids },
      },
      ip: audit.ip,
      user_agent: audit.user_agent,
      device_type: audit.device_type,
      os: audit.os,
      browser: audit.browser,
      tx: client,
    });

    await client.query("COMMIT");

    return {
      id: etatId,
      code,
      designation,
      unite_achat,
      is_active,
      nuance_ids,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function repoListMatiereSousEtats(filters: ListMatiereSousEtatsQueryDTO = {}): Promise<StockMatiereSousEtat[]> {
  const where: string[] = [];
  const values: unknown[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  if (filters.q) {
    const q = `%${filters.q.trim()}%`;
    const p = push(q);
    where.push(`(se.code ILIKE ${p} OR se.designation ILIKE ${p})`);
  }
  if (typeof filters.is_active === "boolean") {
    where.push(`se.is_active = ${push(filters.is_active)}`);
  }
  if (typeof filters.etat_id === "number" && Number.isFinite(filters.etat_id)) {
    where.push(`se.etat_id = ${push(filters.etat_id)}::bigint`);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const res = await db.query<{
    id: number;
    etat_id: number;
    code: string;
    designation: string;
    is_active: boolean;
  }>(
    `
      SELECT
        se.id::int AS id,
        se.etat_id::int AS etat_id,
        se.code,
        se.designation,
        se.is_active
      FROM public.stock_sous_etats se
      ${whereSql}
      ORDER BY se.code ASC
    `,
    values
  );
  return res.rows;
}

export async function repoCreateMatiereSousEtat(body: CreateMatiereSousEtatBodyDTO, audit: AuditContext): Promise<StockMatiereSousEtat> {
  const etat_id = Math.trunc(body.etat_id);
  const code = normalizeStockReferentialCode(body.code, "Sous-etat");
  const designation = body.designation.trim();
  const is_active = body.is_active;

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    let ins;
    try {
      ins = await client.query<StockMatiereSousEtat>(
        `
          INSERT INTO public.stock_sous_etats (etat_id, code, designation, is_active)
          VALUES ($1::bigint,$2,$3,$4)
          RETURNING id::int AS id, etat_id::int AS etat_id, code, designation, is_active
        `,
        [etat_id, code, designation, is_active]
      );
    } catch (err) {
      if (isPgUniqueViolation(err)) {
        throw new HttpError(409, "DUPLICATE_SOUS_ETAT", `Sous-etat ${code} already exists for this etat`);
      }
      if (isPgForeignKeyViolation(err)) {
        throw new HttpError(400, "INVALID_ETAT", "etat_id is invalid");
      }
      throw err;
    }

    const row = ins.rows[0] ?? null;
    if (!row) throw new Error("Failed to create sous-etat");

    await repoInsertAuditLog({
      user_id: audit.user_id,
      body: {
        event_type: "ACTION",
        action: "stock.matiere-sous-etats.create",
        page_key: audit.page_key,
        entity_type: "stock_sous_etats",
        entity_id: String(row.id),
        path: audit.path,
        client_session_id: audit.client_session_id,
        details: { etat_id, code, designation, is_active },
      },
      ip: audit.ip,
      user_agent: audit.user_agent,
      device_type: audit.device_type,
      os: audit.os,
      browser: audit.browser,
      tx: client,
    });

    await client.query("COMMIT");
    return row;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
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

async function syncArticleSubtypeDetails(
  client: Pick<PoolClient, "query">,
  args: {
    article_id: string;
    category: ArticleCategory;
    family_code: string;
    piece_technique_id: string | null;
    article_matiere?: CreateArticleBodyDTO["article_matiere"];
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
        m.longueur_mm ?? null,
        m.longueur_unitaire_mm ?? null,
        m.largeur_mm ?? null,
        m.hauteur_mm ?? null,
        m.epaisseur_mm ?? null,
        m.diametre_mm ?? null,
        m.largeur_plat_mm ?? null,
      ]
    );
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
}

async function getArticleStockSettings(client: Pick<PoolClient, "query">, articleId: string) {
  const res = await client.query<{ stock_managed: boolean; lot_tracking: boolean }>(
    `SELECT stock_managed, lot_tracking FROM public.articles WHERE id = $1::uuid LIMIT 1`,
    [articleId]
  );
  const row = res.rows[0] ?? null;
  if (!row) {
    throw new HttpError(400, "INVALID_ARTICLE", "Unknown article_id");
  }
  return row;
}

async function ensureArticleStockManaged(client: Pick<PoolClient, "query">, articleId: string) {
  const row = await getArticleStockSettings(client, articleId);
  if (!row.stock_managed) {
    throw new HttpError(409, "ARTICLE_NOT_STOCK_MANAGED", "This article is not managed in stock and cannot be used in stock movements");
  }
}

async function ensureLotTrackingRespected(client: Pick<PoolClient, "query">, articleId: string, lines: CreateMovementLineDTO[]) {
  const row = await getArticleStockSettings(client, articleId);
  if (!row.lot_tracking) return;
  const missingLot = lines.some((line) => !line.lot_id);
  if (missingLot) {
    throw new HttpError(409, "LOT_REQUIRED", "This article is lot-tracked and requires lot_id on every movement line");
  }
}

async function ensureArticleCanDisableStockManagement(client: Pick<PoolClient, "query">, articleId: string) {
  const res = await client.query<{ qty_total: number; qty_reserved: number }>(
    `
      SELECT
        COALESCE(SUM(qty_total), 0)::float8 AS qty_total,
        COALESCE(SUM(qty_reserved), 0)::float8 AS qty_reserved
      FROM public.v_stock_current
      WHERE article_id = $1::uuid
    `,
    [articleId]
  );
  const row = res.rows[0] ?? { qty_total: 0, qty_reserved: 0 };
  if (Math.abs(Number(row.qty_total ?? 0)) > 0.0001 || Math.abs(Number(row.qty_reserved ?? 0)) > 0.0001) {
    throw new HttpError(409, "ARTICLE_HAS_STOCK", "This article still has stock or reservations and cannot be switched to non-stock-managed");
  }
}

function articleSortColumn(sortBy: ListArticlesQueryDTO["sortBy"]): string {
  switch (sortBy) {
    case "created_at":
      return "a.created_at";
    case "code":
      return "a.code";
    case "designation":
      return "a.designation";
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

function magasinSortColumn(sortBy: ListMagasinsQueryDTO["sortBy"]): string {
  switch (sortBy) {
    case "created_at":
      return "m.created_at";
    case "code":
      return "COALESCE(m.code, m.code_magasin)";
    case "name":
      return "COALESCE(m.name, m.libelle)";
    case "updated_at":
    default:
      return "m.updated_at";
  }
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

function emplacementSortColumn(sortBy: ListEmplacementsQueryDTO["sortBy"]): string {
  switch (sortBy) {
    case "created_at":
      return "e.created_at";
    case "code":
      return "e.code";
    case "updated_at":
    default:
      return "e.updated_at";
  }
}

function movementSortColumn(sortBy: ListMovementsQueryDTO["sortBy"]): string {
  switch (sortBy) {
    case "id":
      return "m.id";
    case "created_at":
      return "m.created_at";
    case "updated_at":
      return "m.updated_at";
    case "posted_at":
      return "m.posted_at";
    case "movement_no":
      return "m.movement_no";
    case "effective_at":
    default:
      return "m.effective_at";
  }
}

function inventorySessionSortColumn(sortBy: ListInventorySessionsQueryDTO["sortBy"]): string {
  switch (sortBy) {
    case "created_at":
      return "s.created_at";
    case "updated_at":
      return "s.updated_at";
    case "session_no":
      return "s.session_no";
    case "started_at":
    default:
      return "s.started_at";
  }
}

function movementNoFromSeq(n: number): string {
  const padded = String(n).padStart(8, "0");
  return `SM-${padded}`;
}

async function reserveMovementNo(client: Pick<PoolClient, "query">): Promise<string> {
  const res = await client.query<{ n: string }>(`SELECT nextval('public.stock_movement_no_seq')::text AS n`);
  const raw = res.rows[0]?.n;
  const n = raw ? Number(raw) : NaN;
  if (!Number.isFinite(n)) throw new Error("Failed to reserve stock movement number");
  return movementNoFromSeq(n);
}

function inventorySessionNoFromSeq(n: number): string {
  const padded = String(n).padStart(8, "0");
  return `INV-${padded}`;
}

async function reserveInventorySessionNo(client: Pick<PoolClient, "query">): Promise<string> {
  const res = await client.query<{ n: string }>(`SELECT nextval('public.stock_inventory_session_no_seq')::text AS n`);
  const raw = res.rows[0]?.n;
  const n = raw ? Number(raw) : NaN;
  if (!Number.isFinite(n)) throw new Error("Failed to reserve inventory session number");
  return inventorySessionNoFromSeq(n);
}

function parseEffectiveAt(raw: string | null | undefined): Date {
  if (!raw) return new Date();
  const dt = new Date(raw);
  if (Number.isNaN(dt.getTime())) {
    throw new HttpError(400, "INVALID_EFFECTIVE_AT", "Invalid effective_at");
  }
  return dt;
}

async function resolveUnitIdForArticle(
  client: Pick<PoolClient, "query">,
  articleId: string,
  preferredUnitCode: string | null | undefined
): Promise<string> {
  const preferred = preferredUnitCode?.trim() ? preferredUnitCode.trim() : null;
  let code: string | null = preferred;

  if (!code) {
    const a = await client.query<{ unite: string | null }>(
      `SELECT unite FROM public.articles WHERE id = $1::uuid`,
      [articleId]
    );
    code = a.rows[0]?.unite?.trim() ? a.rows[0].unite.trim() : null;
  }

  if (!code) code = "u";

  const u = await client.query<{ id: string }>(`SELECT id::text AS id FROM public.units WHERE code = $1`, [code]);
  const unitId = u.rows[0]?.id;
  if (!unitId) {
    throw new HttpError(400, "UNKNOWN_UNIT", `Unknown unit code: ${code}`);
  }
  return unitId;
}

type EmplacementMapping = {
  magasin_id: string;
  location_id: string;
  warehouse_id: string;
};

async function getEmplacementMapping(
  client: Pick<PoolClient, "query">,
  magasinId: string,
  emplacementId: number,
  label: "src" | "dst"
): Promise<EmplacementMapping> {
  const res = await client.query<{
    magasin_id: string;
    location_id: string | null;
    warehouse_id: string | null;
  }>(
    `
      SELECT
        e.magasin_id::text AS magasin_id,
        e.location_id::text AS location_id,
        l.warehouse_id::text AS warehouse_id
      FROM public.emplacements e
      LEFT JOIN public.locations l ON l.id = e.location_id
      WHERE e.id = $1::bigint
    `,
    [emplacementId]
  );

  const row = res.rows[0] ?? null;
  if (!row) {
    throw new HttpError(400, "INVALID_LOCATION", `Unknown ${label}_emplacement_id`);
  }
  if (row.magasin_id !== magasinId) {
    throw new HttpError(400, "INVALID_LOCATION", `${label}_emplacement_id does not belong to ${label}_magasin_id`);
  }
  if (!row.location_id || !row.warehouse_id) {
    throw new HttpError(409, "LOCATION_NOT_MAPPED", `Emplacement is missing ${label} location mapping`);
  }

  return {
    magasin_id: row.magasin_id,
    location_id: row.location_id,
    warehouse_id: row.warehouse_id,
  };
}

async function ensureStockLevel(
  client: Pick<PoolClient, "query">,
  args: {
    article_id: string;
    unit_id: string;
    warehouse_id: string;
    location_id: string;
    actor_user_id: number;
  }
): Promise<string> {
  const existing = await client.query<{
    id: string;
    unit_id: string;
    warehouse_id: string;
  }>(
    `
      SELECT
        id::text AS id,
        unit_id::text AS unit_id,
        warehouse_id::text AS warehouse_id
      FROM public.stock_levels
      WHERE article_id = $1::uuid AND location_id = $2::uuid
    `,
    [args.article_id, args.location_id]
  );

  const row = existing.rows[0] ?? null;
  if (row) {
    if (row.unit_id !== args.unit_id) {
      throw new HttpError(409, "STOCK_LEVEL_UNIT_MISMATCH", "Stock level unit mismatch");
    }
    if (row.warehouse_id !== args.warehouse_id) {
      throw new HttpError(409, "STOCK_LEVEL_WAREHOUSE_MISMATCH", "Stock level warehouse mismatch");
    }
    return row.id;
  }

  await client.query(
    `
      INSERT INTO public.stock_levels (
        article_id, unit_id, warehouse_id, location_id,
        managed_in_stock,
        created_by, updated_by
      )
      VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,true,$5,$5)
      ON CONFLICT (article_id, location_id) DO NOTHING
    `,
    [args.article_id, args.unit_id, args.warehouse_id, args.location_id, args.actor_user_id]
  );

  const after = await client.query<{ id: string }>(
    `SELECT id::text AS id FROM public.stock_levels WHERE article_id = $1::uuid AND location_id = $2::uuid`,
    [args.article_id, args.location_id]
  );
  const id = after.rows[0]?.id;
  if (!id) throw new Error("Failed to ensure stock level");
  return id;
}

async function ensureStockBatchId(
  client: Pick<PoolClient, "query">,
  args: {
    stock_level_id: string;
    lot_id: string;
  }
): Promise<string> {
  const lot = await client.query<{ lot_code: string }>(
    `SELECT lot_code FROM public.lots WHERE id = $1::uuid`,
    [args.lot_id]
  );
  const lotCode = lot.rows[0]?.lot_code;
  if (!lotCode) throw new HttpError(400, "INVALID_LOT", "Unknown lot_id");

  await client.query(
    `
      INSERT INTO public.stock_batches (stock_level_id, batch_code)
      VALUES ($1::uuid,$2)
      ON CONFLICT (stock_level_id, batch_code) DO NOTHING
    `,
    [args.stock_level_id, lotCode]
  );

  const b = await client.query<{ id: string }>(
    `SELECT id::text AS id FROM public.stock_batches WHERE stock_level_id = $1::uuid AND batch_code = $2`,
    [args.stock_level_id, lotCode]
  );
  const id = b.rows[0]?.id;
  if (!id) throw new Error("Failed to ensure stock batch");
  return id;
}

function sumQty(lines: CreateMovementLineDTO[]): number {
  return lines.reduce((acc, l) => acc + (typeof l.qty === "number" ? l.qty : 0), 0);
}

function assertSameArticle(lines: CreateMovementLineDTO[]) {
  const first = lines[0]?.article_id;
  if (!first) throw new HttpError(400, "INVALID_MOVEMENT", "Missing article_id");
  for (const l of lines) {
    if (l.article_id !== first) {
      throw new HttpError(400, "INVALID_MOVEMENT", "All movement lines must have the same article_id");
    }
  }
}

function assertSameLotIfSet(lines: CreateMovementLineDTO[]): string | null {
  const firstLot = lines[0]?.lot_id ?? null;
  for (const l of lines) {
    const lot = l.lot_id ?? null;
    if (lot !== firstLot) return null;
  }
  return firstLot;
}

type MovementLocationKey = {
  direction: "IN" | "OUT" | null;
  src_magasin_id: string | null;
  src_emplacement_id: number | null;
  dst_magasin_id: string | null;
  dst_emplacement_id: number | null;
};

function movementLocationKey(lines: CreateMovementLineDTO[], movementType: StockMovementTypeDTO): MovementLocationKey {
  const first = lines[0];
  if (!first) throw new HttpError(400, "INVALID_MOVEMENT", "Missing movement lines");

  if (movementType === "ADJUST" || movementType === "ADJUSTMENT") {
    const dir = first.direction ?? null;
    if (dir !== "IN" && dir !== "OUT") {
      throw new HttpError(400, "INVALID_MOVEMENT", "ADJUSTMENT movement requires direction");
    }
    for (const l of lines) {
      if (l.direction !== dir) {
        throw new HttpError(400, "INVALID_MOVEMENT", "All ADJUSTMENT lines must share the same direction");
      }
    }
    return {
      direction: dir,
      src_magasin_id: first.src_magasin_id ?? null,
      src_emplacement_id: first.src_emplacement_id ?? null,
      dst_magasin_id: first.dst_magasin_id ?? null,
      dst_emplacement_id: first.dst_emplacement_id ?? null,
    };
  }

  return {
    direction: null,
    src_magasin_id: first.src_magasin_id ?? null,
    src_emplacement_id: first.src_emplacement_id ?? null,
    dst_magasin_id: first.dst_magasin_id ?? null,
    dst_emplacement_id: first.dst_emplacement_id ?? null,
  };
}

function assertConsistentLocations(lines: CreateMovementLineDTO[], movementType: StockMovementTypeDTO) {
  const first = movementLocationKey(lines, movementType);
  for (const l of lines) {
    const cur: MovementLocationKey =
      movementType === "ADJUST" || movementType === "ADJUSTMENT"
        ? {
            direction: l.direction ?? null,
            src_magasin_id: l.src_magasin_id ?? null,
            src_emplacement_id: l.src_emplacement_id ?? null,
            dst_magasin_id: l.dst_magasin_id ?? null,
            dst_emplacement_id: l.dst_emplacement_id ?? null,
          }
        : {
            direction: null,
            src_magasin_id: l.src_magasin_id ?? null,
            src_emplacement_id: l.src_emplacement_id ?? null,
            dst_magasin_id: l.dst_magasin_id ?? null,
            dst_emplacement_id: l.dst_emplacement_id ?? null,
          };

    if (movementType === "IN") {
      if (cur.dst_magasin_id !== first.dst_magasin_id || cur.dst_emplacement_id !== first.dst_emplacement_id) {
        throw new HttpError(400, "INVALID_MOVEMENT", "All IN lines must share the same destination location");
      }
    } else if (movementType === "OUT" || movementType === "RESERVE" || movementType === "UNRESERVE" || movementType === "DEPRECIATE" || movementType === "SCRAP") {
      if (cur.src_magasin_id !== first.src_magasin_id || cur.src_emplacement_id !== first.src_emplacement_id) {
        throw new HttpError(400, "INVALID_MOVEMENT", `All ${movementType} lines must share the same source location`);
      }
    } else if (movementType === "TRANSFER") {
      if (
        cur.src_magasin_id !== first.src_magasin_id ||
        cur.src_emplacement_id !== first.src_emplacement_id ||
        cur.dst_magasin_id !== first.dst_magasin_id ||
        cur.dst_emplacement_id !== first.dst_emplacement_id
      ) {
        throw new HttpError(400, "INVALID_MOVEMENT", "All TRANSFER lines must share the same source and destination locations");
      }
    } else if (movementType === "ADJUST" || movementType === "ADJUSTMENT") {
      if (cur.direction !== first.direction) {
        throw new HttpError(400, "INVALID_MOVEMENT", "All ADJUSTMENT lines must share the same direction");
      }
      if (first.direction === "IN") {
        if (cur.dst_magasin_id !== first.dst_magasin_id || cur.dst_emplacement_id !== first.dst_emplacement_id) {
          throw new HttpError(400, "INVALID_MOVEMENT", "All ADJUSTMENT IN lines must share the same destination location");
        }
      } else {
        if (cur.src_magasin_id !== first.src_magasin_id || cur.src_emplacement_id !== first.src_emplacement_id) {
          throw new HttpError(400, "INVALID_MOVEMENT", "All ADJUSTMENT OUT lines must share the same source location");
        }
      }
    }
  }
}

async function insertMovementEvent(
  client: Pick<PoolClient, "query">,
  args: {
    movement_id: string;
    event_type: string;
    old_values: unknown | null;
    new_values: unknown | null;
    user_id: number;
  }
) {
  await client.query(
    `
      INSERT INTO public.stock_movement_event_log (
        stock_movement_id, event_type, old_values, new_values,
        user_id,
        created_by, updated_by
      )
      VALUES ($1::uuid,$2,$3::jsonb,$4::jsonb,$5,$5,$5)
    `,
    [args.movement_id, args.event_type, JSON.stringify(args.old_values), JSON.stringify(args.new_values), args.user_id]
  );
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
      OR a.designation ILIKE ${p}
      OR a.family_code ILIKE ${p}
      OR COALESCE(pt.code_piece, '') ILIKE ${p}
      OR COALESCE(pt.designation, '') ILIKE ${p}
      OR COALESCE(pt.designation_2, '') ILIKE ${p}
    )`);
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
  if (filters.status) where.push(`a.status = ${push(filters.status)}`);
  if (filters.projet_id) where.push(`a.projet_id = ${push(filters.projet_id)}`);
  if (filters.family_code) where.push(`a.family_code = ${push(normalizeFamilyCode(filters.family_code, "GEN"))}`);
  if (filters.is_active !== undefined) where.push(`a.is_active = ${push(filters.is_active)}`);
  if (filters.lot_tracking !== undefined) where.push(`a.lot_tracking = ${push(filters.lot_tracking)}`);
  if (filters.stock_managed !== undefined) where.push(`a.stock_managed = ${push(filters.stock_managed)}`);

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const orderBy = articleSortColumn(filters.sortBy);
  const orderDir = sortDirection(filters.sortDir);

  const countRes = await db.query<{ total: number }>(
    `
      SELECT COUNT(*)::int AS total
      FROM public.articles a
      LEFT JOIN public.pieces_techniques pt ON pt.id = a.piece_technique_id
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
      CASE WHEN ${normalizedArticleCategorySql("a.article_category")} = 'fabrique' THEN 'PIECE_TECHNIQUE' ELSE 'PURCHASED' END AS article_type,
      ${normalizedArticleCategorySql("a.article_category")} AS article_category,
      COALESCE(ac.categories, ARRAY[${normalizedBusinessCategorySql("a.article_category")}]::text[]) AS article_categories,
      a.family_code,
      a.stock_managed,
      a.piece_technique_id::text AS piece_technique_id,
      pt.code_piece AS piece_code,
      pt.designation AS piece_designation,
      a.unite,
      a.lot_tracking,
      a.is_active,
      COALESCE(bs.qty_available, 0)::float8 AS qty_available,
      COALESCE(bs.qty_reserved, 0)::float8 AS qty_reserved,
      COALESCE(bs.qty_total, 0)::float8 AS qty_total,
      COALESCE(bs.locations_count, 0)::int AS locations_count,
      a.updated_at::text AS updated_at,
      a.created_at::text AS created_at
    FROM public.articles a
    LEFT JOIN public.pieces_techniques pt
      ON pt.id = a.piece_technique_id
    LEFT JOIN (
      SELECT
        article_id::text AS article_id,
        COUNT(*)::int AS locations_count,
        COALESCE(SUM(qty_available), 0)::float8 AS qty_available,
        COALESCE(SUM(qty_reserved), 0)::float8 AS qty_reserved,
        COALESCE(SUM(qty_total), 0)::float8 AS qty_total
      FROM public.v_stock_current
      GROUP BY article_id
    ) bs ON bs.article_id = a.id::text
    LEFT JOIN LATERAL (
      SELECT array_agg(acl.category_code ORDER BY acl.is_primary DESC, acl.category_code ASC)::text[] AS categories
      FROM public.article_category_link acl
      WHERE acl.article_id = a.id
    ) ac ON TRUE
    ${whereSql}
    ORDER BY ${orderBy} ${orderDir}
    LIMIT $${values.length + 1}
    OFFSET $${values.length + 2}
  `;

  const rows = await db.query<StockArticleListItem>(dataSql, [...values, pageSize, offset]);
  return { items: rows.rows, total };
}

export async function repoGetArticle(id: string): Promise<StockArticleDetail | null> {
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
        CASE WHEN ${normalizedArticleCategorySql("a.article_category")} = 'fabrique' THEN 'PIECE_TECHNIQUE' ELSE 'PURCHASED' END AS article_type,
        ${normalizedArticleCategorySql("a.article_category")} AS article_category,
      COALESCE(ac.categories, ARRAY[${normalizedBusinessCategorySql("a.article_category")}]::text[]) AS article_categories,
        a.family_code,
        a.stock_managed,
        a.piece_technique_id::text AS piece_technique_id,
        pt.code_piece AS piece_code,
        pt.designation AS piece_designation,
        a.unite,
         a.lot_tracking,
         a.is_active,
         a.notes,
         CASE
           WHEN ${normalizedArticleCategorySql("a.article_category")} <> 'matiere' THEN NULL
           WHEN am.article_id IS NULL THEN NULL
           ELSE jsonb_build_object(
             'nuance_id', am.nuance_id,
             'etat_id', am.etat_id,
             'sous_etat_id', am.sous_etat_id,
             'barre_a_decouper', am.barre_a_decouper,
             'longueur_mm', am.longueur_mm,
             'longueur_unitaire_mm', am.longueur_unitaire_mm,
             'largeur_mm', am.largeur_mm,
             'hauteur_mm', am.hauteur_mm,
             'epaisseur_mm', am.epaisseur_mm,
             'diametre_mm', am.diametre_mm,
             'largeur_plat_mm', am.largeur_plat_mm
           )
         END AS article_matiere,
         COALESCE(bs.qty_available, 0)::float8 AS qty_available,
         COALESCE(bs.qty_reserved, 0)::float8 AS qty_reserved,
         COALESCE(bs.qty_total, 0)::float8 AS qty_total,
         COALESCE(bs.locations_count, 0)::int AS locations_count,
         a.updated_at::text AS updated_at,
         a.created_at::text AS created_at
       FROM public.articles a
       LEFT JOIN public.pieces_techniques pt
         ON pt.id = a.piece_technique_id
       LEFT JOIN public.articles_matiere am
         ON am.article_id = a.id
       LEFT JOIN (
         SELECT
           article_id::text AS article_id,
           COUNT(*)::int AS locations_count,
           COALESCE(SUM(qty_available), 0)::float8 AS qty_available,
           COALESCE(SUM(qty_reserved), 0)::float8 AS qty_reserved,
           COALESCE(SUM(qty_total), 0)::float8 AS qty_total
        FROM public.v_stock_current
        GROUP BY article_id
      ) bs ON bs.article_id = a.id::text
      LEFT JOIN LATERAL (
        SELECT array_agg(acl.category_code ORDER BY acl.is_primary DESC, acl.category_code ASC)::text[] AS categories
        FROM public.article_category_link acl
        WHERE acl.article_id = a.id
      ) ac ON TRUE
      WHERE a.id = $1::uuid
    `,
    [id]
  );
  return res.rows[0] ?? null;
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

export async function repoCreateArticle(body: CreateArticleBodyDTO, audit: AuditContext): Promise<StockArticleDetail> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const normalized = await normalizeArticleState({
      article_type: body.article_type,
      article_category: body.article_category,
      article_categories: body.article_categories,
      family_code: body.family_code,
      version_number: body.version_number,
      plan_index: body.plan_index,
      status: body.status,
      projet_id: body.projet_id ?? null,
      piece_technique_id: body.piece_technique_id ?? null,
      stock_managed: body.stock_managed,
      lot_tracking: body.lot_tracking,
      code: body.code,
      designation: body.designation,
      client,
    });

    if (normalized.piece_technique_id) {
      await ensurePieceTechniqueExists(client, normalized.piece_technique_id);
    }

    const articleId = crypto.randomUUID();

    const res = await client.query<{ id: string }>(
      `
        INSERT INTO public.articles (
          id,
          code, designation, article_type, article_category, family_code, stock_managed, piece_technique_id, unite,
          root_article_id, parent_article_id, version_number, plan_index, status, projet_id,
          lot_tracking, is_active, notes,
          created_by, updated_by
        )
        VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8::uuid,$9,$10::uuid,$11::uuid,$12,$13,$14,$15,$16,$17,$18,$19,$19)
        RETURNING id::text AS id
      `,
      [
        articleId,
        normalized.code,
        body.designation,
        normalized.article_type,
        normalized.article_category,
        normalized.family_code,
        normalized.stock_managed,
        normalized.piece_technique_id,
        body.unite ?? null,
        articleId,
        null,
        normalized.version_number,
        normalized.plan_index,
        normalized.status,
        normalized.projet_id,
        normalized.lot_tracking,
        body.is_active,
        body.notes ?? null,
        audit.user_id,
      ]
    );

    const id = res.rows[0]?.id;
    if (!id) throw new Error("Failed to create article");
    await syncArticleCategories(client, id, normalized.article_categories, audit.user_id);

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
    });

    await insertAuditLog(client, audit, {
      action: "stock.articles.create",
      entity_type: "articles",
      entity_id: id,
      details: {
        code: normalized.code,
        designation: body.designation,
        article_type: normalized.article_type,
        article_category: normalized.article_category,
        article_categories: normalized.article_categories,
        family_code: normalized.family_code,
        version_number: normalized.version_number,
        plan_index: normalized.plan_index,
        status: normalized.status,
        projet_id: normalized.projet_id,
        stock_managed: normalized.stock_managed,
      },
    });

    await client.query("COMMIT");

    const out = await repoGetArticle(id);
    if (!out) throw new Error("Failed to read created article");

    return out;
  } catch (err) {
    await client.query("ROLLBACK");
    if (isPgUniqueViolation(err)) {
      throw new HttpError(409, "DUPLICATE", "Article code already exists");
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function repoUpdateArticle(
  id: string,
  patch: UpdateArticleBodyDTO,
  audit: AuditContext
): Promise<StockArticleDetail | null> {
  const client = await db.connect();
  const sets: string[] = [];
  const values: unknown[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  try {
    await client.query("BEGIN");

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
          lot_tracking
        FROM public.articles
        WHERE id = $1::uuid
        FOR UPDATE
      `,
      [id]
    );
    const current = currentRes.rows[0] ?? null;
    if (!current) {
      await client.query("ROLLBACK");
      return null;
    }

    const normalized = await normalizeArticleState({
      article_type: patch.article_type ?? current.article_type,
      article_category: patch.article_category ?? current.article_category,
      article_categories: patch.article_categories ?? current.article_categories,
      family_code: patch.family_code ?? current.family_code,
      version_number: patch.version_number ?? current.version_number,
      plan_index: patch.plan_index ?? current.plan_index,
      status: patch.status ?? current.status,
      projet_id: patch.projet_id !== undefined ? patch.projet_id : current.projet_id,
      piece_technique_id: patch.piece_technique_id !== undefined ? patch.piece_technique_id : current.piece_technique_id,
      stock_managed: patch.stock_managed ?? current.stock_managed,
      lot_tracking: patch.lot_tracking ?? current.lot_tracking,
      code: patch.code ?? current.code ?? "",
      designation: patch.designation ?? current.designation,
      client,
    });

    if (current.stock_managed && !normalized.stock_managed) {
      await ensureArticleCanDisableStockManagement(client, id);
    }

    sets.push(`code = ${push(normalized.code)}`);
    if (patch.designation !== undefined) sets.push(`designation = ${push(patch.designation)}`);
    sets.push(`article_type = ${push(normalized.article_type)}`);
    sets.push(`article_category = ${push(normalized.article_category)}`);
    sets.push(`version_number = ${push(normalized.version_number)}`);
    sets.push(`plan_index = ${push(normalized.plan_index)}`);
    sets.push(`status = ${push(normalized.status)}`);
    sets.push(`projet_id = ${push(normalized.projet_id)}::bigint`);
    sets.push(`family_code = ${push(normalized.family_code)}`);
    sets.push(`stock_managed = ${push(normalized.stock_managed)}`);
    sets.push(`piece_technique_id = ${push(normalized.piece_technique_id)}::uuid`);
    if (patch.unite !== undefined) sets.push(`unite = ${push(patch.unite)}`);
    sets.push(`lot_tracking = ${push(normalized.lot_tracking)}`);
    if (patch.is_active !== undefined) sets.push(`is_active = ${push(patch.is_active)}`);
    if (patch.notes !== undefined) sets.push(`notes = ${push(patch.notes)}`);

    sets.push(`updated_at = now()`);
    sets.push(`updated_by = ${push(audit.user_id)}`);

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
    });

    await insertAuditLog(client, audit, {
      action: "stock.articles.update",
      entity_type: "articles",
      entity_id: id,
      details: {
        patch,
        normalized,
      },
    });

    await client.query("COMMIT");

    return repoGetArticle(id);
  } catch (err) {
    await client.query("ROLLBACK");
    if (isPgUniqueViolation(err)) {
      throw new HttpError(409, "DUPLICATE", "Article code already exists");
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function repoListMagasins(filters: ListMagasinsQueryDTO): Promise<Paginated<StockMagasinListItem>> {
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
    where.push(
      `(
        COALESCE(m.code, m.code_magasin) ILIKE ${p}
        OR COALESCE(m.name, m.libelle) ILIKE ${p}
      )`
    );
  }
  if (filters.is_active !== undefined) where.push(`m.is_active = ${push(filters.is_active)}`);

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const orderBy = magasinSortColumn(filters.sortBy);
  const orderDir = sortDirection(filters.sortDir);

  const countRes = await db.query<{ total: number }>(
    `SELECT COUNT(*)::int AS total FROM public.magasins m ${whereSql}`,
    values
  );
  const total = countRes.rows[0]?.total ?? 0;

  const dataSql = `
    SELECT
      m.id::text AS id,
      COALESCE(m.code, m.code_magasin)::text AS code,
      COALESCE(m.name, m.libelle)::text AS name,
      m.is_active,
      COALESCE(m.updated_at, now())::text AS updated_at,
      COALESCE(m.created_at, now())::text AS created_at,
      COALESCE(ec.emplacements_count, 0)::int AS emplacements_count,
      COALESCE(ec.scrap_emplacements_count, 0)::int AS scrap_emplacements_count
    FROM public.magasins m
    LEFT JOIN (
      SELECT
        magasin_id,
        COUNT(*)::int AS emplacements_count,
        COUNT(*) FILTER (WHERE is_scrap)::int AS scrap_emplacements_count
      FROM public.emplacements
      GROUP BY magasin_id
    ) ec ON ec.magasin_id = m.id
    ${whereSql}
    ORDER BY ${orderBy} ${orderDir}
    LIMIT $${values.length + 1}
    OFFSET $${values.length + 2}
  `;

  const rows = await db.query<StockMagasinListItem>(dataSql, [...values, pageSize, offset]);
  return { items: rows.rows, total };
}

export async function repoGetMagasin(id: string): Promise<StockMagasinDetail | null> {
  const m = await db.query<StockMagasinDetail["magasin"]>(
    `
      SELECT
        id::text AS id,
        COALESCE(code, code_magasin)::text AS code,
        COALESCE(name, libelle)::text AS name,
        is_active,
        notes,
        COALESCE(updated_at, now())::text AS updated_at,
        COALESCE(created_at, now())::text AS created_at
      FROM public.magasins
      WHERE id = $1::uuid
    `,
    [id]
  );

  const magasin = m.rows[0] ?? null;
  if (!magasin) return null;

  const e = await db.query<StockEmplacementListItem>(
    `
      SELECT
        e.id::int AS id,
        e.magasin_id::text AS magasin_id,
        COALESCE(m.code, m.code_magasin)::text AS magasin_code,
        COALESCE(m.name, m.libelle)::text AS magasin_name,
        e.code,
        e.name,
        e.is_scrap,
        e.is_active,
        e.updated_at::text AS updated_at,
        e.created_at::text AS created_at
      FROM public.emplacements e
      JOIN public.magasins m ON m.id = e.magasin_id
      WHERE e.magasin_id = $1::uuid
      ORDER BY e.code ASC, e.id ASC
    `,
    [id]
  );

  return { magasin, emplacements: e.rows };
}

export async function repoGetMagasinsKpis(): Promise<StockMagasinKpis> {
  const res = await db.query<StockMagasinKpis>(
    `
      SELECT
        (SELECT COUNT(*) FROM public.magasins)::int AS magasins_total,
        (SELECT COUNT(*) FROM public.magasins WHERE is_active)::int AS magasins_active,
        (SELECT COUNT(*) FROM public.emplacements)::int AS emplacements_total,
        (SELECT COUNT(*) FROM public.emplacements WHERE is_scrap)::int AS emplacements_scrap
    `
  );
  return (
    res.rows[0] ?? {
      magasins_total: 0,
      magasins_active: 0,
      emplacements_total: 0,
      emplacements_scrap: 0,
    }
  );
}

export async function repoCreateMagasin(body: CreateMagasinBodyDTO, audit: AuditContext): Promise<StockMagasinDetail["magasin"]> {
  try {
    const res = await db.query<{ id: string }>(
      `
        INSERT INTO public.magasins (
          code_magasin, libelle,
          code, name,
          actif, is_active,
          notes,
          created_by, updated_by
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)
        RETURNING id::text AS id
      `,
      [
        body.code,
        body.name,
        body.code,
        body.name,
        body.is_active,
        body.is_active,
        body.notes ?? null,
        audit.user_id,
      ]
    );
    const id = res.rows[0]?.id;
    if (!id) throw new Error("Failed to create magasin");

    await insertAuditLog(db, audit, {
      action: "stock.magasins.create",
      entity_type: "magasins",
      entity_id: id,
      details: { code: body.code, name: body.name },
    });

    const out = await repoGetMagasin(id);
    if (!out) throw new Error("Failed to read created magasin");
    return out.magasin;
  } catch (err) {
    if (isPgUniqueViolation(err)) {
      throw new HttpError(409, "DUPLICATE", "Magasin code already exists");
    }
    throw err;
  }
}

export async function repoUpdateMagasin(
  id: string,
  patch: UpdateMagasinBodyDTO,
  audit: AuditContext
): Promise<StockMagasinDetail["magasin"] | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  if (patch.code !== undefined) {
    sets.push(`code = ${push(patch.code)}`);
    sets.push(`code_magasin = ${push(patch.code)}`);
  }
  if (patch.name !== undefined) {
    sets.push(`name = ${push(patch.name)}`);
    sets.push(`libelle = ${push(patch.name)}`);
  }
  if (patch.is_active !== undefined) {
    sets.push(`is_active = ${push(patch.is_active)}`);
    sets.push(`actif = ${push(patch.is_active)}`);
  }
  if (patch.notes !== undefined) sets.push(`notes = ${push(patch.notes)}`);
  sets.push(`updated_at = now()`);
  sets.push(`updated_by = ${push(audit.user_id)}`);

  try {
    const res = await db.query<{ id: string }>(
      `UPDATE public.magasins SET ${sets.join(", ")} WHERE id = ${push(id)}::uuid RETURNING id::text AS id`,
      values
    );
    if (!res.rows[0]?.id) return null;

    await insertAuditLog(db, audit, {
      action: "stock.magasins.update",
      entity_type: "magasins",
      entity_id: id,
      details: { patch },
    });

    const out = await repoGetMagasin(id);
    return out?.magasin ?? null;
  } catch (err) {
    if (isPgUniqueViolation(err)) {
      throw new HttpError(409, "DUPLICATE", "Magasin code already exists");
    }
    throw err;
  }
}

export async function repoDeactivateMagasin(id: string, audit: AuditContext): Promise<StockMagasinDetail["magasin"] | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const exists = await client.query<{ id: string }>(
      `SELECT id::text AS id FROM public.magasins WHERE id = $1::uuid FOR UPDATE`,
      [id]
    );
    if (!exists.rows[0]?.id) {
      await client.query("ROLLBACK");
      return null;
    }

    const blocking = await client.query<{ key: string; value_text: string }>(
      `
        SELECT s.key, s.value_text
        FROM public.erp_settings s
        WHERE s.key IN ('stock.default_shipping_location','stock.default_receipt_location')
          AND s.value_text IS NOT NULL
          AND s.value_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          AND EXISTS (
            SELECT 1
            FROM public.emplacements e
            WHERE e.magasin_id = $1::uuid
              AND e.location_id = s.value_text::uuid
          )
        LIMIT 1
      `,
      [id]
    );

    const blocked = blocking.rows[0] ?? null;
    if (blocked) {
      throw new HttpError(
        409,
        "MAGASIN_DEFAULT_LOCATION",
        "Impossible de desactiver ce magasin : il contient l'emplacement utilise comme emplacement par defaut dans les parametres."
      );
    }

    await client.query(
      `
        UPDATE public.magasins
        SET
          is_active = false,
          actif = false,
          updated_at = now(),
          updated_by = $2
        WHERE id = $1::uuid
      `,
      [id, audit.user_id]
    );

    await insertAuditLog(client, audit, {
      action: "stock.magasins.deactivate",
      entity_type: "magasins",
      entity_id: id,
      details: null,
    });

    await client.query("COMMIT");
    const out = await repoGetMagasin(id);
    return out?.magasin ?? null;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function repoActivateMagasin(id: string, audit: AuditContext): Promise<StockMagasinDetail["magasin"] | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const exists = await client.query<{ id: string }>(
      `SELECT id::text AS id FROM public.magasins WHERE id = $1::uuid FOR UPDATE`,
      [id]
    );
    if (!exists.rows[0]?.id) {
      await client.query("ROLLBACK");
      return null;
    }

    await client.query(
      `
        UPDATE public.magasins
        SET
          is_active = true,
          actif = true,
          updated_at = now(),
          updated_by = $2
        WHERE id = $1::uuid
      `,
      [id, audit.user_id]
    );

    await insertAuditLog(client, audit, {
      action: "stock.magasins.activate",
      entity_type: "magasins",
      entity_id: id,
      details: null,
    });

    await client.query("COMMIT");
    const out = await repoGetMagasin(id);
    return out?.magasin ?? null;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function repoListEmplacements(filters: ListEmplacementsQueryDTO): Promise<Paginated<StockEmplacementListItem>> {
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 50;
  const offset = (page - 1) * pageSize;

  const where: string[] = [];
  const values: unknown[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  if (filters.magasin_id) where.push(`e.magasin_id = ${push(filters.magasin_id)}::uuid`);
  if (filters.is_active !== undefined) where.push(`e.is_active = ${push(filters.is_active)}`);
  if (filters.is_scrap !== undefined) where.push(`e.is_scrap = ${push(filters.is_scrap)}`);
  if (filters.q && filters.q.trim().length > 0) {
    const q = normalizeLikeQuery(filters.q);
    const p = push(q);
    where.push(
      `(
        e.code ILIKE ${p}
        OR COALESCE(e.name, '') ILIKE ${p}
        OR COALESCE(m.code, m.code_magasin) ILIKE ${p}
        OR COALESCE(m.name, m.libelle) ILIKE ${p}
      )`
    );
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const orderBy = emplacementSortColumn(filters.sortBy);
  const orderDir = sortDirection(filters.sortDir);

  const countRes = await db.query<{ total: number }>(
    `SELECT COUNT(*)::int AS total FROM public.emplacements e JOIN public.magasins m ON m.id = e.magasin_id ${whereSql}`,
    values
  );
  const total = countRes.rows[0]?.total ?? 0;

  const dataSql = `
    SELECT
      e.id::int AS id,
      e.magasin_id::text AS magasin_id,
      COALESCE(m.code, m.code_magasin)::text AS magasin_code,
      COALESCE(m.name, m.libelle)::text AS magasin_name,
      e.code,
      e.name,
      e.is_scrap,
      e.is_active,
      e.updated_at::text AS updated_at,
      e.created_at::text AS created_at
    FROM public.emplacements e
    JOIN public.magasins m ON m.id = e.magasin_id
    ${whereSql}
    ORDER BY ${orderBy} ${orderDir}
    LIMIT $${values.length + 1}
    OFFSET $${values.length + 2}
  `;
  const rows = await db.query<StockEmplacementListItem>(dataSql, [...values, pageSize, offset]);
  return { items: rows.rows, total };
}

export async function repoCreateEmplacement(
  magasinId: string,
  body: CreateEmplacementBodyDTO,
  audit: AuditContext
): Promise<StockEmplacementListItem | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const mag = await client.query<{ ok: number; code: string; name: string }>(
      `
        SELECT
          1::int AS ok,
          COALESCE(code, code_magasin)::text AS code,
          COALESCE(name, libelle)::text AS name
        FROM public.magasins
        WHERE id = $1::uuid
        FOR UPDATE
      `,
      [magasinId]
    );
    const base = mag.rows[0] ?? null;
    if (!base?.ok) {
      await client.query("ROLLBACK");
      return null;
    }

    const ins = await client.query<{ id: number }>(
      `
        INSERT INTO public.emplacements (magasin_id, code, name, is_scrap, is_active, notes, created_by, updated_by)
        VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$7)
        RETURNING id::int AS id
      `,
      [magasinId, body.code, body.name ?? null, body.is_scrap, body.is_active, body.notes ?? null, audit.user_id]
    );
    const id = ins.rows[0]?.id;
    if (!id) throw new Error("Failed to create emplacement");

    // Ensure an emplacement is mapped to a stock location (required by movements).
    // Legacy databases may not have triggers to maintain this mapping.
    const warehouseCode = base.code;
    const warehouseName = base.name;

    let warehouseId = (
      await client.query<{ id: string }>(
        `SELECT id::text AS id FROM public.warehouses WHERE code = $1::citext LIMIT 1`,
        [warehouseCode]
      )
    ).rows[0]?.id;

    if (!warehouseId) {
      try {
        warehouseId = (
          await client.query<{ id: string }>(
            `INSERT INTO public.warehouses (code, name) VALUES ($1::citext,$2) RETURNING id::text AS id`,
            [warehouseCode, warehouseName]
          )
        ).rows[0]?.id;
      } catch (err) {
        if (isPgUniqueViolation(err)) {
          warehouseId = (
            await client.query<{ id: string }>(
              `SELECT id::text AS id FROM public.warehouses WHERE code = $1::citext LIMIT 1`,
              [warehouseCode]
            )
          ).rows[0]?.id;
        } else {
          throw err;
        }
      }
    }

    if (!warehouseId) throw new Error("Failed to resolve warehouse for emplacement");

    const locationCode = `${warehouseCode}-${body.code}`;
    let locationId = (
      await client.query<{ id: string }>(
        `SELECT id::text AS id FROM public.locations WHERE warehouse_id = $1::uuid AND code = $2::citext LIMIT 1`,
        [warehouseId, locationCode]
      )
    ).rows[0]?.id;

    if (!locationId) {
      try {
        locationId = (
          await client.query<{ id: string }>(
            `
              INSERT INTO public.locations (warehouse_id, code, description)
              VALUES ($1::uuid,$2::citext,$3)
              RETURNING id::text AS id
            `,
            [warehouseId, locationCode, `Emplacement ${body.code}`]
          )
        ).rows[0]?.id;
      } catch (err) {
        if (isPgUniqueViolation(err)) {
          locationId = (
            await client.query<{ id: string }>(
              `SELECT id::text AS id FROM public.locations WHERE warehouse_id = $1::uuid AND code = $2::citext LIMIT 1`,
              [warehouseId, locationCode]
            )
          ).rows[0]?.id;
        } else {
          throw err;
        }
      }
    }

    if (!locationId) throw new Error("Failed to resolve location for emplacement");

    await client.query(
      `UPDATE public.emplacements SET location_id = $2::uuid, updated_at = now(), updated_by = $3 WHERE id = $1::bigint`,
      [id, locationId, audit.user_id]
    );

    await insertAuditLog(client, audit, {
      action: "stock.emplacements.create",
      entity_type: "emplacements",
      entity_id: String(id),
      details: {
        magasin_id: magasinId,
        magasin_code: base.code,
        code: body.code,
        is_scrap: body.is_scrap,
      },
    });

    await client.query("COMMIT");

    const out = await db.query<StockEmplacementListItem>(
      `
        SELECT
          e.id::int AS id,
          e.magasin_id::text AS magasin_id,
          COALESCE(m.code, m.code_magasin)::text AS magasin_code,
          COALESCE(m.name, m.libelle)::text AS magasin_name,
          e.code,
          e.name,
          e.is_scrap,
          e.is_active,
          e.updated_at::text AS updated_at,
          e.created_at::text AS created_at
        FROM public.emplacements e
        JOIN public.magasins m ON m.id = e.magasin_id
        WHERE e.id = $1::bigint
      `,
      [id]
    );
    return out.rows[0] ?? null;
  } catch (err) {
    await client.query("ROLLBACK");
    if (isPgUniqueViolation(err)) {
      throw new HttpError(409, "DUPLICATE", "Emplacement code already exists in this magasin");
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function repoUpdateEmplacement(
  id: number,
  patch: UpdateEmplacementBodyDTO,
  audit: AuditContext
): Promise<StockEmplacementListItem | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  if (patch.code !== undefined) sets.push(`code = ${push(patch.code)}`);
  if (patch.name !== undefined) sets.push(`name = ${push(patch.name)}`);
  if (patch.is_scrap !== undefined) sets.push(`is_scrap = ${push(patch.is_scrap)}`);
  if (patch.is_active !== undefined) sets.push(`is_active = ${push(patch.is_active)}`);
  if (patch.notes !== undefined) sets.push(`notes = ${push(patch.notes)}`);
  sets.push(`updated_at = now()`);
  sets.push(`updated_by = ${push(audit.user_id)}`);

  try {
    const res = await db.query<{ id: number }>(
      `UPDATE public.emplacements SET ${sets.join(", ")} WHERE id = ${push(id)}::bigint RETURNING id::int AS id`,
      values
    );
    if (!res.rows[0]?.id) return null;

    await insertAuditLog(db, audit, {
      action: "stock.emplacements.update",
      entity_type: "emplacements",
      entity_id: String(id),
      details: { patch },
    });

    const out = await db.query<StockEmplacementListItem>(
      `
        SELECT
          e.id::int AS id,
          e.magasin_id::text AS magasin_id,
          COALESCE(m.code, m.code_magasin)::text AS magasin_code,
          COALESCE(m.name, m.libelle)::text AS magasin_name,
          e.code,
          e.name,
          e.is_scrap,
          e.is_active,
          e.updated_at::text AS updated_at,
          e.created_at::text AS created_at
        FROM public.emplacements e
        JOIN public.magasins m ON m.id = e.magasin_id
        WHERE e.id = $1::bigint
      `,
      [id]
    );
    return out.rows[0] ?? null;
  } catch (err) {
    if (isPgUniqueViolation(err)) {
      throw new HttpError(409, "DUPLICATE", "Emplacement code already exists in this magasin");
    }
    throw err;
  }
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
      l.supplier_lot_code,
      l.received_at::text AS received_at,
      l.manufactured_at::text AS manufactured_at,
      l.expiry_at::text AS expiry_at,
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
        l.lot_code,
        l.supplier_lot_code,
        l.received_at::text AS received_at,
        l.manufactured_at::text AS manufactured_at,
        l.expiry_at::text AS expiry_at,
        l.notes,
        l.updated_at::text AS updated_at,
        l.created_at::text AS created_at
      FROM public.lots l
      JOIN public.articles a ON a.id = l.article_id
      WHERE l.id = $1::uuid
    `,
    [id]
  );
  return res.rows[0] ?? null;
}

export async function repoCreateLot(body: CreateLotBodyDTO, audit: AuditContext): Promise<StockLotDetail> {
  try {
    const res = await db.query<{ id: string }>(
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
        body.lot_code,
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

    await insertAuditLog(db, audit, {
      action: "stock.lots.create",
      entity_type: "lots",
      entity_id: id,
      details: { article_id: body.article_id, lot_code: body.lot_code },
    });

    const out = await repoGetLot(id);
    if (!out) throw new Error("Failed to read created lot");
    return out;
  } catch (err) {
    if (isPgUniqueViolation(err)) {
      throw new HttpError(409, "DUPLICATE", "Lot code already exists for this article");
    }
    throw err;
  }
}

export async function repoUpdateLot(id: string, patch: UpdateLotBodyDTO, audit: AuditContext): Promise<StockLotDetail | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  if (patch.lot_code !== undefined) sets.push(`lot_code = ${push(patch.lot_code)}`);
  if (patch.supplier_lot_code !== undefined) sets.push(`supplier_lot_code = ${push(patch.supplier_lot_code)}`);
  if (patch.received_at !== undefined) sets.push(`received_at = ${push(patch.received_at)}::date`);
  if (patch.manufactured_at !== undefined) sets.push(`manufactured_at = ${push(patch.manufactured_at)}::date`);
  if (patch.expiry_at !== undefined) sets.push(`expiry_at = ${push(patch.expiry_at)}::date`);
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

export async function repoListBalances(filters: ListBalancesQueryDTO): Promise<Paginated<StockBalanceRow>> {
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 100;
  const offset = (page - 1) * pageSize;

  const where: string[] = [];
  const values: unknown[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  if (filters.article_id) where.push(`b.article_id = ${push(filters.article_id)}::uuid`);
  if (filters.magasin_id) where.push(`e.magasin_id = ${push(filters.magasin_id)}::uuid`);
  if (filters.emplacement_id) where.push(`e.id = ${push(filters.emplacement_id)}::bigint`);
  if (filters.lot_id) where.push(`1 = 0`);
  if (filters.warehouse_id) where.push(`b.warehouse_id = ${push(filters.warehouse_id)}::uuid`);
  if (filters.location_id) where.push(`b.location_id = ${push(filters.location_id)}::uuid`);
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const countRes = await db.query<{ total: number }>(
    `
      SELECT COUNT(*)::int AS total
      FROM public.v_stock_current b
      LEFT JOIN public.emplacements e ON e.location_id = b.location_id
      ${whereSql}
    `,
    values
  );
  const total = countRes.rows[0]?.total ?? 0;

  const dataSql = `
    SELECT
      b.id::text AS id,
      b.article_id::text AS article_id,
      a.code AS article_code,
      a.designation AS article_designation,
      e.magasin_id::text AS magasin_id,
      COALESCE(m.code, m.code_magasin)::text AS magasin_code,
      COALESCE(m.name, m.libelle)::text AS magasin_name,
      e.id::int AS emplacement_id,
      e.code AS emplacement_code,
      e.name AS emplacement_name,
      NULL::text AS lot_id,
      NULL::text AS lot_code,
      b.warehouse_id::text AS warehouse_id,
      w.code::text AS warehouse_code,
      w.name AS warehouse_name,
      b.location_id::text AS location_id,
      l.code::text AS location_code,
      l.description AS location_description,
      b.unit_id::text AS unit_id,
      u.code::text AS unit_code,
      b.managed_in_stock,
      b.qty_total::float8 AS qty_on_hand,
      b.qty_reserved::float8 AS qty_reserved,
      b.qty_available::float8 AS qty_available,
      b.updated_at::text AS updated_at
    FROM public.v_stock_current b
    JOIN public.articles a ON a.id = b.article_id
    JOIN public.warehouses w ON w.id = b.warehouse_id
    JOIN public.locations l ON l.id = b.location_id
    JOIN public.units u ON u.id = b.unit_id
    LEFT JOIN public.emplacements e ON e.location_id = b.location_id
    LEFT JOIN public.magasins m ON m.id = e.magasin_id
    ${whereSql}
    ORDER BY a.code ASC, COALESCE(m.code, m.code_magasin, w.code) ASC, COALESCE(e.code, l.code) ASC
    LIMIT $${values.length + 1}
    OFFSET $${values.length + 2}
  `;

  const rows = await db.query<StockBalanceRow>(dataSql, [...values, pageSize, offset]);
  return { items: rows.rows, total };
}

export async function repoGetStockAnalytics(filters: ListAnalyticsQueryDTO): Promise<StockAnalytics> {
  const movementValues: unknown[] = [];
  const currentValues: unknown[] = [];
  const pushMovement = (v: unknown) => {
    movementValues.push(v);
    return `$${movementValues.length}`;
  };
  const pushCurrent = (v: unknown) => {
    currentValues.push(v);
    return `$${currentValues.length}`;
  };

  const movementWhere: string[] = [
    `m.status = 'POSTED'`,
    `(m.doc_type IS DISTINCT FROM 'STOCK_TRANSFER_INTERNAL')`,
    `(m.movement_type IN ('IN','OUT','SCRAP','ADJUSTMENT','ADJUST'))`,
  ];

  const currentWhere: string[] = [];

  if (filters.from) movementWhere.push(`m.effective_at >= ${pushMovement(filters.from)}::timestamptz`);
  if (filters.to) movementWhere.push(`m.effective_at <= ${pushMovement(filters.to)}::timestamptz`);
  if (filters.magasin_id) {
    movementWhere.push(`e.magasin_id = ${pushMovement(filters.magasin_id)}::uuid`);
    currentWhere.push(`e.magasin_id = ${pushCurrent(filters.magasin_id)}::uuid`);
  }

  const movementWhereSql = movementWhere.length ? `WHERE ${movementWhere.join(" AND ")}` : "";
  const currentWhereSql = currentWhere.length ? `WHERE ${currentWhere.join(" AND ")}` : "";
  const currentWhereSqlCombined = currentWhereSql.replace(/\$(\d+)/g, (_match, n: string) => `$${Number(n) + movementValues.length}`);

  const [kpisRes, magasinsRes, categoriesRes, seriesRes, topArticlesRes] = await Promise.all([
    db.query<StockAnalytics["kpis"]>(
      `
        SELECT
          COUNT(*)::int AS articles_count,
          COUNT(*) FILTER (WHERE a.stock_managed)::int AS stock_managed_articles,
          COALESCE(SUM(cur.qty_total), 0)::float8 AS qty_on_hand,
          COALESCE(SUM(cur.qty_available), 0)::float8 AS qty_available,
          COALESCE(SUM(cur.qty_reserved), 0)::float8 AS qty_reserved
        FROM public.articles a
        LEFT JOIN (
          SELECT
            b.article_id,
            SUM(b.qty_total)::float8 AS qty_total,
            SUM(b.qty_available)::float8 AS qty_available,
            SUM(b.qty_reserved)::float8 AS qty_reserved
          FROM public.v_stock_current b
          LEFT JOIN public.emplacements e ON e.location_id = b.location_id
          ${currentWhereSql}
          GROUP BY b.article_id
        ) cur ON cur.article_id = a.id
      `,
      currentValues
    ),
    db.query<{ id: string; code: string; name: string }>(
      `
        SELECT id::text AS id, COALESCE(code, code_magasin)::text AS code, COALESCE(name, libelle)::text AS name
        FROM public.magasins
        WHERE is_active = true
        ORDER BY COALESCE(code, code_magasin) ASC
      `
    ),
    db.query<StockAnalytics["category_counts"][number]>(
      `
        SELECT
          a.article_category::text AS article_category,
          COUNT(*)::int AS articles_count,
          COUNT(*) FILTER (WHERE a.stock_managed)::int AS stock_managed_count
        FROM public.articles a
        GROUP BY a.article_category
        ORDER BY a.article_category ASC
      `
    ),
    db.query<StockAnalytics["series"]["net_by_date"][number]>(
      `
        SELECT
          to_char(date_trunc('day', m.effective_at), 'YYYY-MM-DD') AS date,
          COALESCE(SUM(
            CASE
              WHEN m.movement_type = 'IN'::public.movement_type THEN ABS(m.qty)
              WHEN m.movement_type IN ('ADJUST'::public.movement_type,'ADJUSTMENT'::public.movement_type) AND m.qty > 0 THEN ABS(m.qty)
              ELSE 0
            END
          ), 0)::float8 AS qty_in,
          COALESCE(SUM(
            CASE
              WHEN m.movement_type IN ('OUT'::public.movement_type,'SCRAP'::public.movement_type) THEN ABS(m.qty)
              WHEN m.movement_type IN ('ADJUST'::public.movement_type,'ADJUSTMENT'::public.movement_type) AND m.qty < 0 THEN ABS(m.qty)
              ELSE 0
            END
          ), 0)::float8 AS qty_out,
          COALESCE(SUM(
            CASE
              WHEN m.movement_type = 'IN'::public.movement_type THEN ABS(m.qty)
              WHEN m.movement_type IN ('ADJUST'::public.movement_type,'ADJUSTMENT'::public.movement_type) AND m.qty > 0 THEN ABS(m.qty)
              WHEN m.movement_type IN ('OUT'::public.movement_type,'SCRAP'::public.movement_type) THEN -ABS(m.qty)
              WHEN m.movement_type IN ('ADJUST'::public.movement_type,'ADJUSTMENT'::public.movement_type) AND m.qty < 0 THEN -ABS(m.qty)
              ELSE 0
            END
          ), 0)::float8 AS net_qty
        FROM public.stock_movements m
        LEFT JOIN public.stock_levels sl ON sl.id = m.stock_level_id
        LEFT JOIN public.emplacements e ON e.location_id = sl.location_id
        ${movementWhereSql}
        GROUP BY date_trunc('day', m.effective_at)
        ORDER BY date ASC
      `,
      movementValues
    ),
    db.query<StockAnalytics["series"]["top_articles"][number]>(
      `
        WITH moved AS (
          SELECT
            m.article_id,
            SUM(ABS(m.qty))::float8 AS qty_moved
          FROM public.stock_movements m
          LEFT JOIN public.stock_levels sl ON sl.id = m.stock_level_id
          LEFT JOIN public.emplacements e ON e.location_id = sl.location_id
          ${movementWhereSql}
          GROUP BY m.article_id
        ), current_stock AS (
          SELECT
            b.article_id,
            SUM(b.qty_total)::float8 AS qty_on_hand,
            SUM(b.qty_available)::float8 AS qty_available
          FROM public.v_stock_current b
          LEFT JOIN public.emplacements e ON e.location_id = b.location_id
          ${currentWhereSqlCombined}
          GROUP BY b.article_id
        )
        SELECT
          a.id::text AS article_id,
          a.code,
          a.designation,
          COALESCE(moved.qty_moved, 0)::float8 AS qty_moved,
          COALESCE(current_stock.qty_on_hand, 0)::float8 AS qty_on_hand,
          COALESCE(current_stock.qty_available, 0)::float8 AS qty_available
        FROM public.articles a
        LEFT JOIN moved ON moved.article_id = a.id
        LEFT JOIN current_stock ON current_stock.article_id = a.id
        WHERE COALESCE(moved.qty_moved, 0) > 0 OR COALESCE(current_stock.qty_on_hand, 0) > 0
        ORDER BY COALESCE(moved.qty_moved, 0) DESC, a.code ASC
        LIMIT 8
      `,
      [...movementValues, ...currentValues]
    ),
  ]);

  return {
    kpis:
      kpisRes.rows[0] ?? {
        articles_count: 0,
        stock_managed_articles: 0,
        qty_on_hand: 0,
        qty_available: 0,
        qty_reserved: 0,
      },
    magasins: magasinsRes.rows,
    category_counts: categoriesRes.rows,
    series: {
      net_by_date: seriesRes.rows,
      top_articles: topArticlesRes.rows,
    },
  };
}

export async function repoListMovements(filters: ListMovementsQueryDTO): Promise<Paginated<StockMovementListItem>> {
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 50;
  const offset = (page - 1) * pageSize;

  const where: string[] = [`(m.doc_type IS DISTINCT FROM 'STOCK_TRANSFER_INTERNAL')`];
  const values: unknown[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  if (filters.q && filters.q.trim().length > 0) {
    const q = normalizeLikeQuery(filters.q);
    const p = push(q);
    where.push(`(m.movement_no ILIKE ${p} OR COALESCE(m.source_document_id, '') ILIKE ${p})`);
  }
  if (filters.movement_type) where.push(`m.movement_type = ${push(filters.movement_type)}::public.movement_type`);
  if (filters.status) where.push(`m.status = ${push(filters.status)}`);
  if (filters.article_id) where.push(`m.article_id = ${push(filters.article_id)}::uuid`);
  if (filters.from) where.push(`m.effective_at >= ${push(filters.from)}::timestamptz`);
  if (filters.to) where.push(`m.effective_at <= ${push(filters.to)}::timestamptz`);

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const orderBy = movementSortColumn(filters.sortBy);
  const orderDir = sortDirection(filters.sortDir);

  const countRes = await db.query<{ total: number }>(`SELECT COUNT(*)::int AS total FROM public.stock_movements m ${whereSql}`, values);
  const total = countRes.rows[0]?.total ?? 0;

  const dataSql = `
    SELECT
      m.id::text AS id,
      m.movement_no,
      m.movement_type::text AS movement_type,
      m.status,
      m.article_id::text AS article_id,
      a.code AS article_code,
      a.designation AS article_designation,
      ABS(m.qty)::float8 AS qty_total,
      m.effective_at::text AS effective_at,
      m.posted_at::text AS posted_at,
      m.source_document_type,
      m.source_document_id,
      m.reason_code,
      m.updated_at::text AS updated_at,
      m.created_at::text AS created_at,
      COALESCE(ml.lines_count, 0)::int AS lines_count
    FROM public.stock_movements m
    JOIN public.articles a ON a.id = m.article_id
    LEFT JOIN (
      SELECT movement_id, COUNT(*)::int AS lines_count
      FROM public.stock_movement_lines
      GROUP BY movement_id
    ) ml ON ml.movement_id = m.id
    ${whereSql}
    ORDER BY ${orderBy} ${orderDir}
    LIMIT $${values.length + 1}
    OFFSET $${values.length + 2}
  `;

  const rows = await db.query<StockMovementListItem>(dataSql, [...values, pageSize, offset]);
  return { items: rows.rows, total };
}

type MovementRow = StockMovementDetail["movement"];

export async function repoGetMovement(id: string): Promise<StockMovementDetail | null> {
  const m = await db.query<MovementRow>(
    `
      SELECT
        id::text AS id,
        movement_no,
        movement_type::text AS movement_type,
        status,
        article_id::text AS article_id,
        stock_level_id::text AS stock_level_id,
        stock_batch_id::text AS stock_batch_id,
        qty::float8 AS qty,
        effective_at::text AS effective_at,
        posted_at::text AS posted_at,
        source_document_type,
        source_document_id,
        reason_code,
        notes,
        created_at::text AS created_at,
        updated_at::text AS updated_at,
        created_by,
        updated_by,
        posted_by
      FROM public.stock_movements
      WHERE id = $1::uuid
    `,
    [id]
  );
  const movement = m.rows[0] ?? null;
  if (!movement) return null;

  const l = await db.query<StockMovementLineDetail>(
    `
      SELECT
        l.id::text AS id,
        l.movement_id::text AS movement_id,
        l.line_no::int AS line_no,
        l.article_id::text AS article_id,
        a.code AS article_code,
        a.designation AS article_designation,
        l.lot_id::text AS lot_id,
        lot.lot_code AS lot_code,
        l.qty::float8 AS qty,
        l.unite,
        l.unit_cost::float8 AS unit_cost,
        l.currency,
        l.src_magasin_id::text AS src_magasin_id,
        COALESCE(sm.code, sm.code_magasin)::text AS src_magasin_code,
        COALESCE(sm.name, sm.libelle)::text AS src_magasin_name,
        l.src_emplacement_id::int AS src_emplacement_id,
        se.code AS src_emplacement_code,
        se.name AS src_emplacement_name,
        l.dst_magasin_id::text AS dst_magasin_id,
        COALESCE(dm.code, dm.code_magasin)::text AS dst_magasin_code,
        COALESCE(dm.name, dm.libelle)::text AS dst_magasin_name,
        l.dst_emplacement_id::int AS dst_emplacement_id,
        de.code AS dst_emplacement_code,
        de.name AS dst_emplacement_name,
        l.note,
        l.direction
      FROM public.stock_movement_lines l
      JOIN public.articles a ON a.id = l.article_id
      LEFT JOIN public.lots lot ON lot.id = l.lot_id
      LEFT JOIN public.magasins sm ON sm.id = l.src_magasin_id
      LEFT JOIN public.emplacements se ON se.id = l.src_emplacement_id
      LEFT JOIN public.magasins dm ON dm.id = l.dst_magasin_id
      LEFT JOIN public.emplacements de ON de.id = l.dst_emplacement_id
      WHERE l.movement_id = $1::uuid
      ORDER BY l.line_no ASC, l.id ASC
    `,
    [id]
  );

  const docs = await db.query<StockDocument>(
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
    [id]
  );

  const events = await db.query<StockMovementEvent>(
    `
      SELECT
        id::text AS id,
        stock_movement_id::text AS stock_movement_id,
        event_type,
        old_values,
        new_values,
        user_id,
        created_at::text AS created_at
      FROM public.stock_movement_event_log
      WHERE stock_movement_id = $1::uuid
      ORDER BY created_at DESC, id DESC
      LIMIT 200
    `,
    [id]
  );

  return {
    movement,
    lines: l.rows,
    documents: docs.rows,
    events: events.rows,
  };
}

export async function repoCreateMovement(body: CreateMovementBodyDTO, audit: AuditContext): Promise<StockMovementDetail> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    assertSameArticle(body.lines);
    assertConsistentLocations(body.lines, body.movement_type);

    const movementNo = await reserveMovementNo(client);
    const effectiveAt = parseEffectiveAt(body.effective_at);
    const articleId = body.lines[0]?.article_id;
    if (!articleId) throw new HttpError(400, "INVALID_MOVEMENT", "Missing article_id");

    await ensureArticleStockManaged(client, articleId);
    await ensureLotTrackingRespected(client, articleId, body.lines);

    const unitId = await resolveUnitIdForArticle(client, articleId, body.lines[0]?.unite ?? null);

    let stockLevelId: string;
    let qtyForMovement: number;
    let direction: "IN" | "OUT" | null = null;

    const first = body.lines[0];
    if (!first) throw new HttpError(400, "INVALID_MOVEMENT", "Missing movement lines");

    const totalQty = sumQty(body.lines);
    if (!Number.isFinite(totalQty) || totalQty === 0) {
      throw new HttpError(400, "INVALID_MOVEMENT", "Invalid qty");
    }

    if (body.movement_type === "IN") {
      if (!first.dst_magasin_id || !first.dst_emplacement_id) {
        throw new HttpError(400, "INVALID_MOVEMENT", "IN requires destination location");
      }
      const map = await getEmplacementMapping(client, first.dst_magasin_id, first.dst_emplacement_id, "dst");
      stockLevelId = await ensureStockLevel(client, {
        article_id: articleId,
        unit_id: unitId,
        warehouse_id: map.warehouse_id,
        location_id: map.location_id,
        actor_user_id: audit.user_id,
      });
      qtyForMovement = totalQty;
    } else if (
      body.movement_type === "OUT" ||
      body.movement_type === "RESERVE" ||
      body.movement_type === "UNRESERVE" ||
      body.movement_type === "DEPRECIATE" ||
      body.movement_type === "SCRAP"
    ) {
      if (!first.src_magasin_id || !first.src_emplacement_id) {
        throw new HttpError(400, "INVALID_MOVEMENT", `${body.movement_type} requires source location`);
      }
      const map = await getEmplacementMapping(client, first.src_magasin_id, first.src_emplacement_id, "src");
      stockLevelId = await ensureStockLevel(client, {
        article_id: articleId,
        unit_id: unitId,
        warehouse_id: map.warehouse_id,
        location_id: map.location_id,
        actor_user_id: audit.user_id,
      });
      qtyForMovement = totalQty;
    } else if (body.movement_type === "TRANSFER") {
      if (!first.src_magasin_id || !first.src_emplacement_id || !first.dst_magasin_id || !first.dst_emplacement_id) {
        throw new HttpError(400, "INVALID_MOVEMENT", "TRANSFER requires source and destination locations");
      }
      const src = await getEmplacementMapping(client, first.src_magasin_id, first.src_emplacement_id, "src");
      await getEmplacementMapping(client, first.dst_magasin_id, first.dst_emplacement_id, "dst");

      stockLevelId = await ensureStockLevel(client, {
        article_id: articleId,
        unit_id: unitId,
        warehouse_id: src.warehouse_id,
        location_id: src.location_id,
        actor_user_id: audit.user_id,
      });
      qtyForMovement = totalQty;
    } else if (body.movement_type === "ADJUST" || body.movement_type === "ADJUSTMENT") {
      direction = first.direction ?? null;
      if (direction !== "IN" && direction !== "OUT") {
        throw new HttpError(400, "INVALID_MOVEMENT", "ADJUSTMENT requires direction");
      }
      if (direction === "IN") {
        if (!first.dst_magasin_id || !first.dst_emplacement_id) {
          throw new HttpError(400, "INVALID_MOVEMENT", "ADJUSTMENT IN requires destination location");
        }
        const dst = await getEmplacementMapping(client, first.dst_magasin_id, first.dst_emplacement_id, "dst");
        stockLevelId = await ensureStockLevel(client, {
          article_id: articleId,
          unit_id: unitId,
          warehouse_id: dst.warehouse_id,
          location_id: dst.location_id,
          actor_user_id: audit.user_id,
        });
        qtyForMovement = totalQty;
      } else {
        if (!first.src_magasin_id || !first.src_emplacement_id) {
          throw new HttpError(400, "INVALID_MOVEMENT", "ADJUSTMENT OUT requires source location");
        }
        const src = await getEmplacementMapping(client, first.src_magasin_id, first.src_emplacement_id, "src");
        stockLevelId = await ensureStockLevel(client, {
          article_id: articleId,
          unit_id: unitId,
          warehouse_id: src.warehouse_id,
          location_id: src.location_id,
          actor_user_id: audit.user_id,
        });
        qtyForMovement = -totalQty;
      }
    } else {
      throw new HttpError(400, "INVALID_MOVEMENT", "Unsupported movement type");
    }

    const uniformLotId = assertSameLotIfSet(body.lines);
    const stockBatchId = uniformLotId
      ? await ensureStockBatchId(client, { stock_level_id: stockLevelId, lot_id: uniformLotId })
      : null;

    const insertMovementSql = `
      INSERT INTO public.stock_movements (
        movement_no,
        movement_type,
        status,
        article_id,
        stock_level_id,
        stock_batch_id,
        qty,
        currency,
        effective_at,
        source_document_type,
        source_document_id,
        reason_code,
        notes,
        idempotency_key,
        user_id,
        created_by,
        updated_by
      )
      VALUES ($1,$2::public.movement_type,'DRAFT',$3::uuid,$4::uuid,$5::uuid,$6,'EUR',$7,$8,$9,$10,$11,$12,$13,$13,$13)
      RETURNING id::text AS id
    `;

    let movementId: string;
    try {
      const ins = await client.query<{ id: string }>(insertMovementSql, [
        movementNo,
        body.movement_type,
        articleId,
        stockLevelId,
        stockBatchId,
        qtyForMovement,
        effectiveAt.toISOString(),
        body.source_document_type ?? null,
        body.source_document_id ?? null,
        body.reason_code ?? null,
        body.notes ?? null,
        body.idempotency_key ?? null,
        audit.user_id,
      ]);
      movementId = ins.rows[0]?.id ?? "";
      if (!movementId) throw new Error("Failed to create movement");
    } catch (err) {
      if (body.idempotency_key && isPgUniqueViolation(err)) {
        const existing = await client.query<{ id: string }>(
          `SELECT id::text AS id FROM public.stock_movements WHERE idempotency_key = $1`,
          [body.idempotency_key]
        );
        const id = existing.rows[0]?.id;
        if (!id) throw err;
        await client.query("COMMIT");
        const out = await repoGetMovement(id);
        if (!out) throw new Error("Failed to read existing idempotent movement");
        return out;
      }
      throw err;
    }

    const linesToInsert = body.lines.map((l, i) => {
      const lineNo = typeof l.line_no === "number" ? l.line_no : i + 1;
      return { ...l, line_no: lineNo };
    });

    for (const line of linesToInsert) {
      if (line.src_magasin_id && line.src_emplacement_id) {
        await getEmplacementMapping(client, line.src_magasin_id, line.src_emplacement_id, "src");
      }
      if (line.dst_magasin_id && line.dst_emplacement_id) {
        await getEmplacementMapping(client, line.dst_magasin_id, line.dst_emplacement_id, "dst");
      }
      if (
        line.src_magasin_id &&
        line.src_emplacement_id &&
        line.dst_magasin_id &&
        line.dst_emplacement_id &&
        line.src_magasin_id === line.dst_magasin_id &&
        line.src_emplacement_id === line.dst_emplacement_id
      ) {
        throw new HttpError(400, "INVALID_LINE", "Source and destination cannot be the same location");
      }

      await client.query(
        `
          INSERT INTO public.stock_movement_lines (
            movement_id, line_no, article_id, lot_id,
            qty, unite, unit_cost, currency,
            src_magasin_id, src_emplacement_id,
            dst_magasin_id, dst_emplacement_id,
            note,
            direction,
            created_by, updated_by
          )
          VALUES ($1::uuid,$2,$3::uuid,$4::uuid,$5,$6,$7,$8,$9::uuid,$10::bigint,$11::uuid,$12::bigint,$13,$14,$15,$15)
        `,
        [
          movementId,
          line.line_no,
          line.article_id,
          line.lot_id ?? null,
          line.qty,
          line.unite ?? null,
          line.unit_cost ?? null,
          line.currency ?? null,
          line.src_magasin_id ?? null,
          line.src_emplacement_id ?? null,
          line.dst_magasin_id ?? null,
          line.dst_emplacement_id ?? null,
          line.note ?? null,
          line.direction ?? null,
          audit.user_id,
        ]
      );
    }

    await insertMovementEvent(client, {
      movement_id: movementId,
      event_type: "CREATED",
      old_values: null,
      new_values: {
        status: "DRAFT",
        movement_type: body.movement_type,
        lines_count: body.lines.length,
      },
      user_id: audit.user_id,
    });

    await insertAuditLog(client, audit, {
      action: "stock.movements.create",
      entity_type: "stock_movements",
      entity_id: movementId,
      details: {
        movement_no: movementNo,
        movement_type: body.movement_type,
        lines_count: body.lines.length,
        idempotency_key: body.idempotency_key ?? null,
      },
    });

    await client.query("COMMIT");
    const out = await repoGetMovement(movementId);
    if (!out) throw new Error("Failed to read created movement");
    return out;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function repoPostMovement(id: string, audit: AuditContext): Promise<StockMovementDetail | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const lock = await client.query<{
      id: string;
      status: string;
      movement_type: StockMovementTypeDTO;
      movement_no: string | null;
      effective_at: string;
      article_id: string;
      notes: string | null;
    }>(
      `
        SELECT
          id::text AS id,
          status,
          movement_type::text AS movement_type,
          movement_no,
          effective_at::text AS effective_at,
          article_id::text AS article_id,
          notes
        FROM public.stock_movements
        WHERE id = $1::uuid
        FOR UPDATE
      `,
      [id]
    );

    const m = lock.rows[0] ?? null;
    if (!m) {
      await client.query("ROLLBACK");
      return null;
    }
    if (m.status !== "DRAFT") {
      throw new HttpError(409, "INVALID_STATUS", "Only DRAFT movements can be posted");
    }

    await ensureArticleStockManaged(client, m.article_id);

    const draftLines = await client.query<CreateMovementLineDTO>(
      `
        SELECT
          line_no,
          article_id::text AS article_id,
          lot_id::text AS lot_id,
          qty::float8 AS qty,
          unite,
          unit_cost::float8 AS unit_cost,
          currency,
          src_magasin_id::text AS src_magasin_id,
          src_emplacement_id::int AS src_emplacement_id,
          dst_magasin_id::text AS dst_magasin_id,
          dst_emplacement_id::int AS dst_emplacement_id,
          note,
          direction
        FROM public.stock_movement_lines
        WHERE movement_id = $1::uuid
        ORDER BY line_no ASC
      `,
      [id]
    );
    await ensureLotTrackingRespected(client, m.article_id, draftLines.rows);

    if (m.movement_type === "TRANSFER") {
      const movementLines = draftLines.rows;
      if (!movementLines.length) {
        throw new HttpError(400, "INVALID_MOVEMENT", "TRANSFER movement has no lines");
      }

      assertSameArticle(movementLines);
        assertConsistentLocations(movementLines, "TRANSFER");

      const totalQty = sumQty(movementLines);
      if (!Number.isFinite(totalQty) || totalQty <= 0) {
        throw new HttpError(400, "INVALID_MOVEMENT", "Invalid TRANSFER qty");
      }

      const first = movementLines[0];
      if (!first?.src_magasin_id || !first.src_emplacement_id || !first.dst_magasin_id || !first.dst_emplacement_id) {
        throw new HttpError(400, "INVALID_MOVEMENT", "TRANSFER requires source and destination locations");
      }

      const unitId = await resolveUnitIdForArticle(client, m.article_id, first.unite ?? null);
      const srcMap = await getEmplacementMapping(client, first.src_magasin_id, first.src_emplacement_id, "src");
      const dstMap = await getEmplacementMapping(client, first.dst_magasin_id, first.dst_emplacement_id, "dst");

      const srcStockLevelId = await ensureStockLevel(client, {
        article_id: m.article_id,
        unit_id: unitId,
        warehouse_id: srcMap.warehouse_id,
        location_id: srcMap.location_id,
        actor_user_id: audit.user_id,
      });
      const dstStockLevelId = await ensureStockLevel(client, {
        article_id: m.article_id,
        unit_id: unitId,
        warehouse_id: dstMap.warehouse_id,
        location_id: dstMap.location_id,
        actor_user_id: audit.user_id,
      });

      const uniformLotId = assertSameLotIfSet(movementLines);
      const srcBatchId = uniformLotId ? await ensureStockBatchId(client, { stock_level_id: srcStockLevelId, lot_id: uniformLotId }) : null;
      const dstBatchId = uniformLotId ? await ensureStockBatchId(client, { stock_level_id: dstStockLevelId, lot_id: uniformLotId }) : null;

      const postedAt = new Date().toISOString();
      const outMovementNo = await reserveMovementNo(client);
      const inMovementNo = await reserveMovementNo(client);

      const outMovement = await client.query<{ id: string }>(
        `
          INSERT INTO public.stock_movements (
            movement_no,
            movement_type,
            status,
            article_id,
            stock_level_id,
            stock_batch_id,
            qty,
            currency,
            effective_at,
            posted_at,
            posted_by,
            doc_type,
            doc_id,
            notes,
            user_id,
            created_by,
            updated_by
          )
          VALUES ($1,'OUT','POSTED',$2::uuid,$3::uuid,$4::uuid,$5,'EUR',$6,$7,$8,'STOCK_TRANSFER_INTERNAL',$9::uuid,$10,$8,$8,$8)
          RETURNING id::text AS id
        `,
        [outMovementNo, m.article_id, srcStockLevelId, srcBatchId, totalQty, m.effective_at, postedAt, audit.user_id, id, m.notes ?? null]
      );
      const outMovementId = outMovement.rows[0]?.id;
      if (!outMovementId) throw new Error("Failed to create OUT transfer movement");

      const inMovement = await client.query<{ id: string }>(
        `
          INSERT INTO public.stock_movements (
            movement_no,
            movement_type,
            status,
            article_id,
            stock_level_id,
            stock_batch_id,
            qty,
            currency,
            effective_at,
            posted_at,
            posted_by,
            doc_type,
            doc_id,
            notes,
            user_id,
            created_by,
            updated_by
          )
          VALUES ($1,'IN','POSTED',$2::uuid,$3::uuid,$4::uuid,$5,'EUR',$6,$7,$8,'STOCK_TRANSFER_INTERNAL',$9::uuid,$10,$8,$8,$8)
          RETURNING id::text AS id
        `,
        [inMovementNo, m.article_id, dstStockLevelId, dstBatchId, totalQty, m.effective_at, postedAt, audit.user_id, id, m.notes ?? null]
      );
      const inMovementId = inMovement.rows[0]?.id;
      if (!inMovementId) throw new Error("Failed to create IN transfer movement");

      for (const line of movementLines) {
        await client.query(
          `
            INSERT INTO public.stock_movement_lines (
              movement_id, line_no, article_id, lot_id,
              qty, unite, unit_cost, currency,
              src_magasin_id, src_emplacement_id,
              dst_magasin_id, dst_emplacement_id,
              note,
              direction,
              created_by, updated_by
            )
            VALUES ($1::uuid,$2,$3::uuid,$4::uuid,$5,$6,$7,$8,$9::uuid,$10::bigint,NULL,NULL,$11,NULL,$12,$12)
          `,
          [
            outMovementId,
            line.line_no,
            line.article_id,
            line.lot_id ?? null,
            line.qty,
            line.unite ?? null,
            line.unit_cost ?? null,
            line.currency ?? null,
            line.src_magasin_id,
            line.src_emplacement_id,
            line.note ?? null,
            audit.user_id,
          ]
        );

        await client.query(
          `
            INSERT INTO public.stock_movement_lines (
              movement_id, line_no, article_id, lot_id,
              qty, unite, unit_cost, currency,
              src_magasin_id, src_emplacement_id,
              dst_magasin_id, dst_emplacement_id,
              note,
              direction,
              created_by, updated_by
            )
            VALUES ($1::uuid,$2,$3::uuid,$4::uuid,$5,$6,$7,$8,NULL,NULL,$9::uuid,$10::bigint,$11,NULL,$12,$12)
          `,
          [
            inMovementId,
            line.line_no,
            line.article_id,
            line.lot_id ?? null,
            line.qty,
            line.unite ?? null,
            line.unit_cost ?? null,
            line.currency ?? null,
            line.dst_magasin_id,
            line.dst_emplacement_id,
            line.note ?? null,
            audit.user_id,
          ]
        );
      }

      await insertMovementEvent(client, {
        movement_id: outMovementId,
        event_type: "CREATED_POSTED",
        old_values: null,
        new_values: { status: "POSTED", movement_type: "OUT", doc_type: "STOCK_TRANSFER_INTERNAL", doc_id: id },
        user_id: audit.user_id,
      });
      await insertMovementEvent(client, {
        movement_id: inMovementId,
        event_type: "CREATED_POSTED",
        old_values: null,
        new_values: { status: "POSTED", movement_type: "IN", doc_type: "STOCK_TRANSFER_INTERNAL", doc_id: id },
        user_id: audit.user_id,
      });

      await client.query(
        `
          UPDATE public.stock_movements
          SET status = 'POSTED', posted_at = now(), posted_by = $2, updated_at = now(), updated_by = $2
          WHERE id = $1::uuid
        `,
        [id, audit.user_id]
      );

      await insertMovementEvent(client, {
        movement_id: id,
        event_type: "POSTED",
        old_values: { status: "DRAFT" },
        new_values: { status: "POSTED" },
        user_id: audit.user_id,
      });

      await insertAuditLog(client, audit, {
        action: "stock.movements.post",
        entity_type: "stock_movements",
        entity_id: id,
        details: {
          movement_no: m.movement_no,
          movement_type: "TRANSFER",
          legs: [
            { movement_id: outMovementId, movement_no: outMovementNo, movement_type: "OUT" },
            { movement_id: inMovementId, movement_no: inMovementNo, movement_type: "IN" },
          ],
        },
      });

      await client.query("COMMIT");
      return repoGetMovement(id);
    }

    await client.query(
      `
        UPDATE public.stock_movements
        SET status = 'POSTED', posted_at = now(), posted_by = $2, updated_at = now(), updated_by = $2
        WHERE id = $1::uuid
      `,
      [id, audit.user_id]
    );

    await insertMovementEvent(client, {
      movement_id: id,
      event_type: "POSTED",
      old_values: { status: "DRAFT" },
      new_values: { status: "POSTED" },
      user_id: audit.user_id,
    });

    await insertAuditLog(client, audit, {
      action: "stock.movements.post",
      entity_type: "stock_movements",
      entity_id: id,
      details: { movement_no: m.movement_no, movement_type: m.movement_type },
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

export async function repoCancelMovement(id: string, audit: AuditContext): Promise<StockMovementDetail | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

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
      `UPDATE public.stock_movements SET status = 'CANCELLED', updated_at = now(), updated_by = $2 WHERE id = $1::uuid`,
      [id, audit.user_id]
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
    const tempPath = path.resolve(doc.path);

    try {
      await fs.rename(tempPath, absPath);
    } catch {
      await fs.copyFile(tempPath, absPath);
      await fs.unlink(tempPath);
    }

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

export async function repoListArticleDocuments(articleId: string): Promise<StockDocument[] | null> {
  const exists = await db.query<{ ok: number }>(
    `SELECT 1::int AS ok FROM public.articles WHERE id = $1::uuid`,
    [articleId]
  );
  if (!exists.rows[0]?.ok) return null;

  const res = await db.query<StockDocument>(
    `
      SELECT
        sd.id::text AS document_id,
        sd.original_name AS document_name,
        ad.type
      FROM public.article_documents ad
      JOIN public.stock_documents sd ON sd.id = ad.document_id
      WHERE ad.article_id = $1::uuid
        AND sd.removed_at IS NULL
      ORDER BY ad.created_at DESC, ad.id DESC
    `,
    [articleId]
  );
  return res.rows;
}

export async function repoAttachArticleDocuments(
  articleId: string,
  documents: UploadedDocument[],
  audit: AuditContext
): Promise<StockDocument[] | null> {
  const client = await db.connect();
  const docsDirRel = path.posix.join("uploads", "docs", "stock", "articles");
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

    const inserted = await insertStockDocuments(client, documents, audit, docsDirRel);
    for (const d of inserted) {
      await client.query(
        `
          INSERT INTO public.article_documents (article_id, document_id, type, version, uploaded_by, created_by, updated_by)
          VALUES ($1::uuid,$2::uuid,$3,$4,$5,$5,$5)
          ON CONFLICT DO NOTHING
        `,
        [articleId, d.id, null, 1, audit.user_id]
      );
    }

    await insertAuditLog(client, audit, {
      action: "stock.articles.documents.attach",
      entity_type: "articles",
      entity_id: articleId,
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

    await client.query("COMMIT");
    return repoListArticleDocuments(articleId);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
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
      `DELETE FROM public.article_documents WHERE article_id = $1::uuid AND document_id = $2::uuid`,
      [articleId, documentId]
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
  const client = await db.connect();
  const docsDirRel = path.posix.join("uploads", "docs", "stock", "movements");
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

    const inserted = await insertStockDocuments(client, documents, audit, docsDirRel);
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

    await client.query("COMMIT");
    return repoListMovementDocuments(movementId);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
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

export async function repoListInventorySessions(
  filters: ListInventorySessionsQueryDTO
): Promise<Paginated<StockInventorySessionListItem>> {
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 50;
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
    where.push(`(s.session_no ILIKE ${p} OR COALESCE(s.notes, '') ILIKE ${p})`);
  }
  if (filters.status) where.push(`s.status = ${push(filters.status)}`);

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const orderBy = inventorySessionSortColumn(filters.sortBy);
  const orderDir = sortDirection(filters.sortDir);

  const countRes = await db.query<{ total: number }>(
    `SELECT COUNT(*)::int AS total FROM public.stock_inventory_sessions s ${whereSql}`,
    values
  );
  const total = countRes.rows[0]?.total ?? 0;

  const dataSql = `
    SELECT
      s.id::text AS id,
      s.session_no,
      s.status,
      s.started_at::text AS started_at,
      s.closed_at::text AS closed_at,
      s.notes,
      s.updated_at::text AS updated_at,
      s.created_at::text AS created_at,
      COALESCE(agg.adjustment_movements_count, 0)::int AS adjustment_movements_count,
      last.last_adjustment_movement_id
    FROM public.stock_inventory_sessions s
    LEFT JOIN (
      SELECT session_id, COUNT(*)::int AS adjustment_movements_count
      FROM public.stock_inventory_session_movements
      GROUP BY session_id
    ) agg ON agg.session_id = s.id
    LEFT JOIN LATERAL (
      SELECT sim.stock_movement_id::text AS last_adjustment_movement_id
      FROM public.stock_inventory_session_movements sim
      WHERE sim.session_id = s.id
      ORDER BY sim.created_at DESC, sim.id DESC
      LIMIT 1
    ) last ON true
    ${whereSql}
    ORDER BY ${orderBy} ${orderDir}
    LIMIT $${values.length + 1}
    OFFSET $${values.length + 2}
  `;

  const rows = await db.query<StockInventorySessionListItem>(dataSql, [...values, pageSize, offset]);
  return { items: rows.rows, total };
}

export async function repoCreateInventorySession(
  body: CreateInventorySessionBodyDTO,
  audit: AuditContext
): Promise<StockInventorySessionListItem> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const sessionNo = await reserveInventorySessionNo(client);
    const ins = await client.query<{ id: string }>(
      `
        INSERT INTO public.stock_inventory_sessions (session_no, status, notes, created_by, updated_by)
        VALUES ($1,'OPEN',$2,$3,$3)
        RETURNING id::text AS id
      `,
      [sessionNo, body.notes ?? null, audit.user_id]
    );
    const id = ins.rows[0]?.id;
    if (!id) throw new Error("Failed to create inventory session");

    await insertAuditLog(client, audit, {
      action: "stock.inventory_sessions.create",
      entity_type: "stock_inventory_sessions",
      entity_id: id,
      details: { session_no: sessionNo },
    });

    await client.query("COMMIT");

    const out = await repoGetInventorySession(id);
    if (!out) throw new Error("Failed to read created inventory session");
    return out.session;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function repoGetInventorySessionRow(id: string): Promise<StockInventorySessionListItem | null> {
  const res = await db.query<StockInventorySessionListItem>(
    `
      SELECT
        s.id::text AS id,
        s.session_no,
        s.status,
        s.started_at::text AS started_at,
        s.closed_at::text AS closed_at,
        s.notes,
        s.updated_at::text AS updated_at,
        s.created_at::text AS created_at,
        COALESCE(agg.adjustment_movements_count, 0)::int AS adjustment_movements_count,
        last.last_adjustment_movement_id
      FROM public.stock_inventory_sessions s
      LEFT JOIN (
        SELECT session_id, COUNT(*)::int AS adjustment_movements_count
        FROM public.stock_inventory_session_movements
        GROUP BY session_id
      ) agg ON agg.session_id = s.id
      LEFT JOIN LATERAL (
        SELECT sim.stock_movement_id::text AS last_adjustment_movement_id
        FROM public.stock_inventory_session_movements sim
        WHERE sim.session_id = s.id
        ORDER BY sim.created_at DESC, sim.id DESC
        LIMIT 1
      ) last ON true
      WHERE s.id = $1::uuid
    `,
    [id]
  );
  return res.rows[0] ?? null;
}

export async function repoGetInventorySession(id: string): Promise<StockInventorySessionDetail | null> {
  const session = await repoGetInventorySessionRow(id);
  if (!session) return null;

  const lines = await repoListInventorySessionLines(id);
  if (!lines) return null;

  const ids = await db.query<{ id: string }>(
    `
      SELECT stock_movement_id::text AS id
      FROM public.stock_inventory_session_movements
      WHERE session_id = $1::uuid
      ORDER BY created_at ASC, id ASC
    `,
    [id]
  );

  return {
    session,
    lines,
    adjustment_movement_ids: ids.rows.map((r) => r.id),
  };
}

export async function repoListInventorySessionLines(id: string): Promise<StockInventorySessionLine[] | null> {
  const session = await db.query<{ ok: number }>(
    `SELECT 1::int AS ok FROM public.stock_inventory_sessions WHERE id = $1::uuid`,
    [id]
  );
  if (!session.rows[0]?.ok) return null;

  const res = await db.query<StockInventorySessionLine>(
    `
      SELECT
        l.id::text AS id,
        l.session_id::text AS session_id,
        l.line_no::int AS line_no,
        l.article_id::text AS article_id,
        a.code AS article_code,
        a.designation AS article_designation,
        l.magasin_id::text AS magasin_id,
        COALESCE(m.code, m.code_magasin)::text AS magasin_code,
        COALESCE(m.name, m.libelle)::text AS magasin_name,
        l.emplacement_id::int AS emplacement_id,
        e.code AS emplacement_code,
        e.name AS emplacement_name,
        l.lot_id::text AS lot_id,
        lot.lot_code AS lot_code,
        l.counted_qty::float8 AS counted_qty,
        (
          CASE
            WHEN l.lot_id IS NOT NULL THEN COALESCE(sb.qty_total, 0)
            ELSE COALESCE(sl.qty_total, 0)
          END
        )::float8 AS qty_on_hand,
        (
          l.counted_qty - (
            CASE
              WHEN l.lot_id IS NOT NULL THEN COALESCE(sb.qty_total, 0)
              ELSE COALESCE(sl.qty_total, 0)
            END
          )
        )::float8 AS delta_qty,
        l.note,
        l.updated_at::text AS updated_at,
        l.created_at::text AS created_at
      FROM public.stock_inventory_lines l
      JOIN public.articles a ON a.id = l.article_id
      JOIN public.magasins m ON m.id = l.magasin_id
      JOIN public.emplacements e ON e.id = l.emplacement_id
      LEFT JOIN public.lots lot ON lot.id = l.lot_id
      LEFT JOIN public.stock_levels sl ON sl.article_id = l.article_id AND sl.location_id = e.location_id
      LEFT JOIN public.stock_batches sb ON sb.stock_level_id = sl.id AND sb.batch_code = lot.lot_code
      WHERE l.session_id = $1::uuid
      ORDER BY l.line_no ASC, l.id ASC
    `,
    [id]
  );

  return res.rows;
}

async function repoGetInventoryLineById(lineId: string): Promise<StockInventorySessionLine | null> {
  const res = await db.query<StockInventorySessionLine>(
    `
      SELECT
        l.id::text AS id,
        l.session_id::text AS session_id,
        l.line_no::int AS line_no,
        l.article_id::text AS article_id,
        a.code AS article_code,
        a.designation AS article_designation,
        l.magasin_id::text AS magasin_id,
        COALESCE(m.code, m.code_magasin)::text AS magasin_code,
        COALESCE(m.name, m.libelle)::text AS magasin_name,
        l.emplacement_id::int AS emplacement_id,
        e.code AS emplacement_code,
        e.name AS emplacement_name,
        l.lot_id::text AS lot_id,
        lot.lot_code AS lot_code,
        l.counted_qty::float8 AS counted_qty,
        (
          CASE
            WHEN l.lot_id IS NOT NULL THEN COALESCE(sb.qty_total, 0)
            ELSE COALESCE(sl.qty_total, 0)
          END
        )::float8 AS qty_on_hand,
        (
          l.counted_qty - (
            CASE
              WHEN l.lot_id IS NOT NULL THEN COALESCE(sb.qty_total, 0)
              ELSE COALESCE(sl.qty_total, 0)
            END
          )
        )::float8 AS delta_qty,
        l.note,
        l.updated_at::text AS updated_at,
        l.created_at::text AS created_at
      FROM public.stock_inventory_lines l
      JOIN public.articles a ON a.id = l.article_id
      JOIN public.magasins m ON m.id = l.magasin_id
      JOIN public.emplacements e ON e.id = l.emplacement_id
      LEFT JOIN public.lots lot ON lot.id = l.lot_id
      LEFT JOIN public.stock_levels sl ON sl.article_id = l.article_id AND sl.location_id = e.location_id
      LEFT JOIN public.stock_batches sb ON sb.stock_level_id = sl.id AND sb.batch_code = lot.lot_code
      WHERE l.id = $1::uuid
      LIMIT 1
    `,
    [lineId]
  );
  return res.rows[0] ?? null;
}

export async function repoUpsertInventoryLine(
  sessionId: string,
  body: UpsertInventoryLineBodyDTO,
  audit: AuditContext
): Promise<StockInventorySessionLine | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const lock = await client.query<{ status: string }>(
      `SELECT status FROM public.stock_inventory_sessions WHERE id = $1::uuid FOR UPDATE`,
      [sessionId]
    );
    const s = lock.rows[0] ?? null;
    if (!s) {
      await client.query("ROLLBACK");
      return null;
    }
    if (s.status !== "OPEN") {
      throw new HttpError(409, "INVALID_STATUS", "Only OPEN sessions can be edited");
    }

    const existing = await client.query<{ id: string }>(
      `
        SELECT id::text AS id
        FROM public.stock_inventory_lines
        WHERE session_id = $1::uuid
          AND article_id = $2::uuid
          AND magasin_id = $3::uuid
          AND emplacement_id = $4::bigint
          AND ((lot_id IS NULL AND $5::uuid IS NULL) OR lot_id = $5::uuid)
        FOR UPDATE
      `,
      [sessionId, body.article_id, body.magasin_id, body.emplacement_id, body.lot_id ?? null]
    );

    let lineId: string;
    if (existing.rows[0]?.id) {
      lineId = existing.rows[0].id;
      await client.query(
        `
          UPDATE public.stock_inventory_lines
          SET counted_qty = $2, note = $3, updated_at = now(), updated_by = $4
          WHERE id = $1::uuid
        `,
        [lineId, body.counted_qty, body.note ?? null, audit.user_id]
      );
    } else {
      const next = await client.query<{ n: number }>(
        `SELECT (COALESCE(MAX(line_no), 0) + 1)::int AS n FROM public.stock_inventory_lines WHERE session_id = $1::uuid`,
        [sessionId]
      );
      const lineNo = next.rows[0]?.n;
      if (!lineNo) throw new Error("Failed to allocate inventory line number");

      const ins = await client.query<{ id: string }>(
        `
          INSERT INTO public.stock_inventory_lines (
            session_id, line_no,
            article_id, magasin_id, emplacement_id, lot_id,
            counted_qty, note,
            created_by, updated_by
          )
          VALUES ($1::uuid,$2,$3::uuid,$4::uuid,$5::bigint,$6::uuid,$7,$8,$9,$9)
          RETURNING id::text AS id
        `,
        [
          sessionId,
          lineNo,
          body.article_id,
          body.magasin_id,
          body.emplacement_id,
          body.lot_id ?? null,
          body.counted_qty,
          body.note ?? null,
          audit.user_id,
        ]
      );
      const idRow = ins.rows[0]?.id;
      if (!idRow) throw new Error("Failed to insert inventory line");
      lineId = idRow;
    }

    await insertAuditLog(client, audit, {
      action: "stock.inventory_sessions.lines.upsert",
      entity_type: "stock_inventory_lines",
      entity_id: lineId,
      details: {
        session_id: sessionId,
        article_id: body.article_id,
        magasin_id: body.magasin_id,
        emplacement_id: body.emplacement_id,
        lot_id: body.lot_id ?? null,
        counted_qty: body.counted_qty,
      },
    });

    await client.query("COMMIT");
    return repoGetInventoryLineById(lineId);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function repoCloseInventorySession(id: string, audit: AuditContext): Promise<StockInventorySessionDetail | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const lock = await client.query<{ status: string; session_no: string }>(
      `SELECT status, session_no FROM public.stock_inventory_sessions WHERE id = $1::uuid FOR UPDATE`,
      [id]
    );
    const s = lock.rows[0] ?? null;
    if (!s) {
      await client.query("ROLLBACK");
      return null;
    }
    if (s.status !== "OPEN") {
      throw new HttpError(409, "INVALID_STATUS", "Only OPEN sessions can be closed");
    }

    const lines = await client.query<StockInventorySessionLine>(
      `
        SELECT
          l.id::text AS id,
          l.session_id::text AS session_id,
          l.line_no::int AS line_no,
          l.article_id::text AS article_id,
          a.code AS article_code,
          a.designation AS article_designation,
          l.magasin_id::text AS magasin_id,
          COALESCE(m.code, m.code_magasin)::text AS magasin_code,
          COALESCE(m.name, m.libelle)::text AS magasin_name,
          l.emplacement_id::int AS emplacement_id,
          e.code AS emplacement_code,
          e.name AS emplacement_name,
          l.lot_id::text AS lot_id,
          lot.lot_code AS lot_code,
          l.counted_qty::float8 AS counted_qty,
          (
            CASE
              WHEN l.lot_id IS NOT NULL THEN COALESCE(sb.qty_total, 0)
              ELSE COALESCE(sl.qty_total, 0)
            END
          )::float8 AS qty_on_hand,
          (
            l.counted_qty - (
              CASE
                WHEN l.lot_id IS NOT NULL THEN COALESCE(sb.qty_total, 0)
                ELSE COALESCE(sl.qty_total, 0)
              END
            )
          )::float8 AS delta_qty,
          l.note,
          l.updated_at::text AS updated_at,
          l.created_at::text AS created_at
        FROM public.stock_inventory_lines l
        JOIN public.articles a ON a.id = l.article_id
        JOIN public.magasins m ON m.id = l.magasin_id
        JOIN public.emplacements e ON e.id = l.emplacement_id
        LEFT JOIN public.lots lot ON lot.id = l.lot_id
        LEFT JOIN public.stock_levels sl ON sl.article_id = l.article_id AND sl.location_id = e.location_id
        LEFT JOIN public.stock_batches sb ON sb.stock_level_id = sl.id AND sb.batch_code = lot.lot_code
        WHERE l.session_id = $1::uuid
        ORDER BY l.line_no ASC
      `,
      [id]
    );

    const adjustments = lines.rows.filter((l) => Math.abs(l.delta_qty) > 1e-9);
    const postedAt = new Date().toISOString();
    const unitCache = new Map<string, string>();

    for (const adj of adjustments) {
      const delta = adj.delta_qty;
      const direction: "IN" | "OUT" = delta > 0 ? "IN" : "OUT";

      let unitId = unitCache.get(adj.article_id);
      if (!unitId) {
        unitId = await resolveUnitIdForArticle(client, adj.article_id, null);
        unitCache.set(adj.article_id, unitId);
      }

      const map = await getEmplacementMapping(client, adj.magasin_id, adj.emplacement_id, direction === "IN" ? "dst" : "src");
      const stockLevelId = await ensureStockLevel(client, {
        article_id: adj.article_id,
        unit_id: unitId,
        warehouse_id: map.warehouse_id,
        location_id: map.location_id,
        actor_user_id: audit.user_id,
      });

      const stockBatchId = adj.lot_id ? await ensureStockBatchId(client, { stock_level_id: stockLevelId, lot_id: adj.lot_id }) : null;
      const movementNo = await reserveMovementNo(client);

      const movement = await client.query<{ id: string }>(
        `
          INSERT INTO public.stock_movements (
            movement_no,
            movement_type,
            status,
            article_id,
            stock_level_id,
            stock_batch_id,
            qty,
            currency,
            effective_at,
            posted_at,
            posted_by,
            source_document_type,
            source_document_id,
            reason_code,
            notes,
            user_id,
            created_by,
            updated_by
          )
          VALUES ($1,'ADJUSTMENT','POSTED',$2::uuid,$3::uuid,$4::uuid,$5,'EUR',now(),$6,$7,$8,$9,'INVENTORY', $10,$7,$7,$7)
          RETURNING id::text AS id
        `,
        [
          movementNo,
          adj.article_id,
          stockLevelId,
          stockBatchId,
          delta,
          postedAt,
          audit.user_id,
          "stock_inventory_session",
          id,
          `inventory ${s.session_no}`,
        ]
      );
      const movementId = movement.rows[0]?.id;
      if (!movementId) throw new Error("Failed to create adjustment movement");

      await client.query(
        `
          INSERT INTO public.stock_movement_lines (
            movement_id, line_no, article_id, lot_id,
            qty, unite,
            src_magasin_id, src_emplacement_id,
            dst_magasin_id, dst_emplacement_id,
            direction,
            note,
            created_by, updated_by
          )
          VALUES ($1::uuid,1,$2::uuid,$3::uuid,$4,$5,$6::uuid,$7::bigint,$8::uuid,$9::bigint,$10,$11,$12,$12)
        `,
        [
          movementId,
          adj.article_id,
          adj.lot_id ?? null,
          Math.abs(delta),
          null,
          direction === "OUT" ? adj.magasin_id : null,
          direction === "OUT" ? adj.emplacement_id : null,
          direction === "IN" ? adj.magasin_id : null,
          direction === "IN" ? adj.emplacement_id : null,
          direction,
          adj.note ?? null,
          audit.user_id,
        ]
      );

      await insertMovementEvent(client, {
        movement_id: movementId,
        event_type: "CREATED_POSTED",
        old_values: null,
        new_values: { status: "POSTED", movement_type: "ADJUSTMENT", delta },
        user_id: audit.user_id,
      });

      await client.query(
        `
          INSERT INTO public.stock_inventory_session_movements (session_id, stock_movement_id)
          VALUES ($1::uuid,$2::uuid)
          ON CONFLICT DO NOTHING
        `,
        [id, movementId]
      );
    }

    await client.query(
      `
        UPDATE public.stock_inventory_sessions
        SET status = 'CLOSED', closed_at = now(), closed_by = $2, updated_at = now(), updated_by = $2
        WHERE id = $1::uuid
      `,
      [id, audit.user_id]
    );

    await insertAuditLog(client, audit, {
      action: "stock.inventory_sessions.close",
      entity_type: "stock_inventory_sessions",
      entity_id: id,
      details: {
        session_no: s.session_no,
        adjustments_count: adjustments.length,
      },
    });

    await client.query("COMMIT");
    return repoGetInventorySession(id);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
