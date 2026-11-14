import type { PoolClient } from "pg";
import db from "../../../config/database";
import { nuanceIdentity, resolveNuanceIdentity, nuanceNormeFields } from "../domain/nuance-library";
import { buildMaterialArticleCode, computeMaterialCodePreviewHash, isSpecialMaterialProfile, normalizeMaterialProfile, type MaterialCodeInput, type MaterialCodeResult, type MaterialProfileCode } from "../../../shared/codes/material-article-code";
import { canonicalizeStockUnitCode } from "../../../shared/stock-unit";
import { HttpError } from "../../../utils/httpError";
import { generateFabricatedArticleBusinessCode } from "../../../shared/codes/code-generator.service";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import type { ArticleCategory, ArticleBusinessCategory, StockArticleCategoryOption, StockArticleFamily, StockMatiereEtat, StockMatiereNuance, StockMatiereSousEtat } from "../types/stock.types";
import type { CreateArticleFamilyBodyDTO, CreateMatiereEtatBodyDTO, CreateMatiereNuanceBodyDTO, CreateMatiereSousEtatBodyDTO, ListArticleFamiliesQueryDTO, ListMatiereEtatsQueryDTO, ListMatiereNuancesQueryDTO, ListMatiereSousEtatsQueryDTO, UpdateMatiereEtatBodyDTO, UpdateMatiereNuanceBodyDTO, UpdateMatiereSousEtatBodyDTO } from "../validators/stock.validators";
import { insertAuditLog, isPgUniqueViolation, type AuditContext } from "./stock-movement-core.repository";

const ARTICLE_PRIMARY_CATEGORY_OPTIONS: Array<{ code: ArticleCategory }> = [
  { code: "fabrique" },
  { code: "matiere" },
  { code: "traitement" },
  { code: "achat" },
];

/**
 * Référentiel des catégories métier d'article.
 *
 * `commande_client_selectable` décrit les catégories qu'un utilisateur peut créer depuis
 * une commande. La sauvegarde Commande reste canonique : seule une pièce fabriquée, gérée
 * en stock, active et reliée à une pièce technique est éligible (BUG-CERP-0015).
 */
const ARTICLE_CATEGORY_OPTIONS: StockArticleCategoryOption[] = [
  {code: "consommable", label: "Consommable", code_segment: "ACH", stock_managed_default: true, piece_technique_required: false, commande_client_selectable: false, is_active: true, sort_order: 45},
  {
    code: "piece_finie_fabriquee",
    label: "Pièce finie / Fabriquée",
    code_segment: "PLAN",
    stock_managed_default: true,
    piece_technique_required: true,
    commande_client_selectable: true,
    is_active: true,
    sort_order: 10,
  },
  {
    code: "matiere_premiere",
    label: "Matière Première",
    code_segment: "MP",
    stock_managed_default: true,
    piece_technique_required: false,
    commande_client_selectable: false,
    is_active: true,
    sort_order: 20,
  },
  {
    code: "traitement_surface",
    label: "Traitement de Surface",
    code_segment: "TRT",
    stock_managed_default: false,
    piece_technique_required: false,
    commande_client_selectable: false,
    is_active: true,
    sort_order: 30,
  },
  {
    code: "achat_revente",
    label: "Achat-Revente",
    code_segment: "ACH",
    stock_managed_default: true,
    piece_technique_required: false,
    commande_client_selectable: false,
    is_active: true,
    sort_order: 40,
  },
  {
    code: "achat_transforme",
    label: "Achat-Transformé",
    code_segment: "AHT",
    stock_managed_default: true,
    piece_technique_required: false,
    commande_client_selectable: false,
    is_active: false,
    sort_order: 90,
  },
  {
    code: "sous_traitance",
    label: "Sous-traitance",
    code_segment: "STA",
    stock_managed_default: false,
    piece_technique_required: false,
    commande_client_selectable: false,
    is_active: true,
    sort_order: 50,
  },
];

/** Codes métier vendables en commande client, dérivés du référentiel ci-dessus. */
export function commandeClientSelectableCategoryCodes(): string[] {
  return ARTICLE_CATEGORY_OPTIONS
    .filter((option) => option.is_active && option.commande_client_selectable)
    .map((option) => option.code);
}

function isArticleCategory(value: string): value is ArticleCategory {
  return value === "fabrique" || value === "matiere" || value === "traitement" || value === "achat";
}

function isArticleBusinessCategory(value: string): value is ArticleBusinessCategory {
  return ARTICLE_CATEGORY_OPTIONS.some((item) => item.code === value);
}

export function toBusinessArticleCategory(requested: string | null | undefined, fallback: ArticleCategory = "achat"): ArticleCategory {
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

export function inferArticleType(category: ArticleCategory): "PIECE_TECHNIQUE" | "PURCHASED" {
  return category === "fabrique" ? "PIECE_TECHNIQUE" : "PURCHASED";
}

export function defaultFamilyCodeForCategory(category: ArticleCategory): string {
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

export const materialFamilyCanonicalMap: Record<string, string> = {
  PLAT: "PL",
  ROND: "RO",
  FONDERI: "FOND",
  FONDERIE: "FOND",
  PROFI: "PROFIL",
  "BRUT-CL": "BRUTCL",
  "BRUT-CLIENT": "BRUTCL",
};

export function normalizeFamilyCode(value: string | null | undefined, fallback: string): string {
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

export function normalizeArticleWorkflowStatus(value: string | null | undefined): "EN_DEVIS" | "VALIDE" {
  const normalized = typeof value === "string" ? value.trim().toUpperCase() : "";
  return normalized === "EN_DEVIS" ? "EN_DEVIS" : "VALIDE";
}

export function normalizeArticleCategories(
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

  push(primaryCategory === "achat" && requested?.includes("consommable") ? "consommable" : defaultBusinessCategoryForPrimary(primaryCategory));
  for (const value of requested ?? []) push(value);
  return out;
}

/**
 * Keeps the primary category explicit and deterministic while allowing the
 * category link table to hold secondary business uses.
 */
export function normalizeArticleCategorySelection(
  primaryCategory: ArticleCategory,
  requestedCategories: string[] | null | undefined
): { article_category: ArticleCategory; article_categories: ArticleBusinessCategory[] } {
  return {
    article_category: primaryCategory,
    article_categories: normalizeArticleCategories(requestedCategories, primaryCategory),
  };
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

function buildSuggestedArticleCode(args: {
  category: ArticleCategory;
  family_code: string;
  final_segment: string;
}): string {
  return `${categoryCodeSegment(args.category)}-${familyCodeSegment(args.family_code)}-${sanitizeCodeToken(args.final_segment, "GEN")}`;
}

export async function resolveArticleCode(
  client: Pick<PoolClient, "query">,
  args: {
    code: string;
    designation: string;
    category: ArticleCategory;
    family_code: string;
    piece_technique_id: string | null;
  }
): Promise<string> {
  if (args.category === "fabrique") {
    if (!args.piece_technique_id) {
      throw new HttpError(400, "INVALID_ARTICLE", "Fabricated articles require piece_technique_id");
    }
    // Client input is deliberately ignored: the server stores an immutable
    // snapshot of the linked technical-piece identity.
    return generateFabricatedArticleBusinessCode(client, args.piece_technique_id);
  }

  const finalSegment = sanitizeCodeToken(args.code || args.designation, "GEN");
  const suggested = buildSuggestedArticleCode({
    category: args.category,
    family_code: args.family_code,
    final_segment: finalSegment,
  });

  const provided = args.code.trim();
  if (!provided) return suggested;

  const normalized = normalizeFullArticleCode(provided);
  return normalized;
}

/* -------------------------------------------------------------------------- */
/* Référence MATIÈRE PREMIÈRE — résolution des segments puis génération        */
/* -------------------------------------------------------------------------- */

export type MaterialCodeRequest = {
  family_code: string;
  nuance_id?: number | null;
  etat_id?: number | null;
  sous_etat_id?: number | null;
  client_proprietaire_id?: string | null;
  reference_suffix?: string | null;
  dimensions?: MaterialCodeInput["dimensions"];
};

async function referentialCode(
  client: Pick<PoolClient, "query">,
  args: { table: "stock_nuances" | "stock_etats" | "stock_sous_etats"; id: number; label: string }
): Promise<string> {
  const res = await client.query<{ code: string | null }>(
    `SELECT code FROM public.${args.table} WHERE id = $1::bigint LIMIT 1`,
    [args.id]
  );
  const code = (res.rows[0]?.code ?? "").trim();
  if (!code) {
    throw new HttpError(400, "INVALID_MATERIAL_REFERENTIAL", `${args.label} introuvable (id ${args.id}).`);
  }
  return code;
}

/**
 * Résout, EN BASE, les codes qui composent une référence matière.
 *
 * Le navigateur n'envoie que des identifiants : c'est le serveur qui lit le
 * code de la nuance, de l'état, du sous-état et du client propriétaire. Une
 * interface qui enverrait un libellé fantaisiste ne peut donc pas influencer la
 * référence produite.
 */
export async function resolveMaterialCodeInput(
  client: Pick<PoolClient, "query">,
  request: MaterialCodeRequest
): Promise<MaterialCodeInput> {
  const profile: MaterialProfileCode = normalizeMaterialProfile(request.family_code);
  const special = isSpecialMaterialProfile(profile);

  const nuanceId = typeof request.nuance_id === "number" && Number.isFinite(request.nuance_id) ? Math.trunc(request.nuance_id) : null;
  const etatId = typeof request.etat_id === "number" && Number.isFinite(request.etat_id) ? Math.trunc(request.etat_id) : null;
  const sousEtatId =
    typeof request.sous_etat_id === "number" && Number.isFinite(request.sous_etat_id) ? Math.trunc(request.sous_etat_id) : null;

  const nuanceCode = !special && nuanceId ? await referentialCode(client, { table: "stock_nuances", id: nuanceId, label: "Nuance" }) : null;
  const etatCode = !special && etatId ? await referentialCode(client, { table: "stock_etats", id: etatId, label: "État" }) : null;
  const sousEtatCode = !special && sousEtatId
    ? await referentialCode(client, { table: "stock_sous_etats", id: sousEtatId, label: "Sous-état" })
    : null;

  let clientCode: string | null = null;
  if (profile === "BRUTCL" || request.client_proprietaire_id?.trim()) {
    const clientId = (request.client_proprietaire_id ?? "").trim();
    if (!clientId) {
      throw new HttpError(
        400,
        "MATERIAL_CLIENT_CODE_REQUIRED",
        "Un brut client exige le client propriétaire pour construire sa référence."
      );
    }
    const res = await client.query<{ client_code: string | null }>(
      `SELECT client_code FROM public.clients WHERE client_id = $1 LIMIT 1`,
      [clientId]
    );
    if (res.rowCount === 0) {
      throw new HttpError(400, "INVALID_CLIENT", `Client propriétaire inconnu : ${clientId}.`);
    }
    // Le code client est la forme lisible ; l'identifiant reste la valeur de
    // secours pour un client historique sans code attribué.
    clientCode = (res.rows[0]?.client_code ?? "").trim() || clientId;
  }

  return {
    profile,
    nuance_code: nuanceCode,
    etat_code: etatCode,
    sous_etat_code: sousEtatCode,
    client_code: clientCode,
    reference_suffix: request.reference_suffix ?? null,
    dimensions: request.dimensions ?? null,
  };
}

export type MaterialCodePreview = MaterialCodeResult & { preview_hash: string };

/**
 * Aperçu serveur de la référence matière. C'est LA MÊME fonction que la
 * création : les deux ne peuvent pas diverger.
 */
export async function repoPreviewMaterialArticleCode(request: MaterialCodeRequest): Promise<MaterialCodePreview> {
  const input = await resolveMaterialCodeInput(db, request);
  const result = buildMaterialArticleCode(input);
  return {
    ...result,
    preview_hash: computeMaterialCodePreviewHash({ input, code: result.code, designation: result.designation }),
  };
}
export function articleFamilyTable(category: ArticleCategory): string {
  if (category === "fabrique") return "articles_fabrique_families";
  if (category === "matiere") return "articles_matiere_families";
  if (category === "traitement") return "articles_traitement_families";
  return "articles_achat_families";
}
export async function repoListArticleCategories(): Promise<StockArticleCategoryOption[]> {
  const exists = await db.query<{ ok: boolean }>(
    `SELECT to_regclass('public.article_category_referential') IS NOT NULL AS ok`
  );
  if (!exists.rows[0]?.ok) {
    return ARTICLE_CATEGORY_OPTIONS.filter((item) => item.is_active).sort((a, b) => a.sort_order - b.sort_order);
  }
  const result = await db.query<StockArticleCategoryOption>(`
    SELECT code, label, code_segment, stock_managed_default, piece_technique_required,
           commande_client_selectable, is_active, sort_order
    FROM public.article_category_referential
    WHERE is_active = true
    ORDER BY sort_order ASC, code ASC
  `);
  return result.rows;
}

export async function repoListStockUnits(): Promise<Array<{ code: string; label: string }>> {
  const res = await db.query<{ code: string; label: string }>(
    `SELECT code, label FROM public.units ORDER BY code ASC`
  );
  const canonical = new Map<string, { code: string; label: string }>();
  for (const row of res.rows) {
    const code = canonicalizeStockUnitCode(row.code);
    if (!code) continue;
    const current = canonical.get(code);
    if (!current || row.code.trim().toLowerCase() === code) {
      canonical.set(code, { code, label: row.label });
    }
  }
  return [...canonical.values()].sort((a, b) => a.code.localeCompare(b.code, "fr"));
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

export async function repoUpdateArticleFamily(input:{category:ArticleCategory;code:string;designation:string;expected_updated_at:string},audit:AuditContext):Promise<StockArticleFamily> {
  const client=await db.connect();
  try {
    await client.query('BEGIN');
    const table=articleFamilyTable(input.category);
    const current=(await client.query<StockArticleFamily>(`SELECT *, $2::text AS category,updated_at::text AS updated_at FROM public.${table} WHERE code=$1 FOR UPDATE`,[input.code,input.category])).rows[0];
    if(!current) throw new HttpError(404,'ARTICLE_FAMILY_NOT_FOUND','Famille introuvable.');
    if(new Date(current.updated_at!).getTime()!==new Date(input.expected_updated_at).getTime()) throw new HttpError(409,'ARTICLE_FAMILY_CHANGED','La famille a changé. Actualisez avant de modifier.');
    const saved=(await client.query<StockArticleFamily>(`UPDATE public.${table} SET designation=$2,updated_at=now() WHERE code=$1 RETURNING code,designation,is_active,created_at::text,updated_at::text,$3::text AS category`,[input.code,input.designation,input.category])).rows[0]!;
    await insertAuditLog(client,audit,{action:'stock.article-families.update',entity_type:'article_families',entity_id:`${input.category}:${input.code}`,details:{before:current,after:saved}});
    await client.query('COMMIT');return saved;
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
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
    where.push(`(n.code ILIKE ${p} OR COALESCE(n.designation, '') ILIKE ${p} OR n.norme_fr ILIKE ${p} OR n.norme_en ILIKE ${p} OR n.norme_werkstoff ILIKE ${p} OR n.norme_usa ILIKE ${p})`);
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
    designation: string | null;
    densite: string | number | null;
    is_active: boolean;
    etat_ids: number[];
    norme_fr: string | null; norme_en: string | null; norme_werkstoff: string | null; norme_usa: string | null;
    designation_principale: "FR" | "EN" | "WERKSTOFF" | "USA" | "LEGACY";
  }>(
    `
      SELECT
        n.id::int AS id,
        n.code, n.norme_fr, n.norme_en, n.norme_werkstoff, n.norme_usa, n.designation_principale,
        n.designation,
        COALESCE(
          NULLIF(to_jsonb(n) ->> 'densite_kg_m3', '')::numeric,
          n.densite * 1000
        ) AS densite,
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
    ...nuanceIdentity(row),
    id: row.id,
    code: row.code,
    designation: row.designation && row.designation.trim() ? row.designation : null,
    densite: row.densite === null ? null : typeof row.densite === "number" ? row.densite : Number(row.densite),
    is_active: row.is_active,
    etat_ids: Array.isArray(row.etat_ids) ? row.etat_ids.filter((v) => typeof v === "number") : [],
  }));
}

export async function repoCreateMatiereNuance(body: CreateMatiereNuanceBodyDTO, audit: AuditContext): Promise<StockMatiereNuance> {
  const identity = resolveNuanceIdentity(body);
  const code = normalizeStockReferentialCode(body.code ?? identity.libelle, "Nuance");
  // Compatibilité pré-patch : la colonne historique est NOT NULL et stocke
  // des kg/dm³. L'API, elle, est désormais exclusivement en kg/m³.
  const designation = body.designation?.trim() || "";
  const densite = body.densite ?? null;
  const legacyDensiteKgDm3 = densite === null ? null : densite / 1000;
  const is_active = body.is_active;
  const etat_ids = uniqPositiveInts(body.etat_ids);

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    await client.query("SELECT pg_advisory_xact_lock(20261113, 84)");
    let ins;
    try {
      ins = await client.query<{ id: number }>(
        `
          INSERT INTO public.stock_nuances (code, designation, densite, is_active, norme_fr, norme_en, norme_werkstoff, norme_usa, designation_principale)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
          RETURNING id::int AS id
        `,
        [code, designation, legacyDensiteKgDm3, is_active, ...nuanceNormeFields.map(key => identity[key]), identity.designation_principale]
      );
    } catch (err) {
      if (isPgUniqueViolation(err)) {
        throw new HttpError(409, "DUPLICATE_NUANCE", "Une nuance possède déjà cette désignation. Recherchez-la dans la bibliothèque, y compris parmi les nuances inactives.");
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
        details: { ...identity, code, designation: designation || null, densite_kg_m3: densite, is_active, etat_ids },
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
      ...identity,
      id: nuanceId,
      code,
      designation: designation || null,
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
    designation: string | null;
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
    // Une désignation vide en base est présentée comme absente : l'écran affiche
    // alors le code, il n'affiche pas « CODE — ».
    designation: row.designation && row.designation.trim() ? row.designation : null,
    unite_achat: typeof row.unite_achat === "number" ? row.unite_achat : Number(row.unite_achat) || 3020,
    is_active: row.is_active,
    nuance_ids: Array.isArray(row.nuance_ids) ? row.nuance_ids.filter((v) => typeof v === "number") : [],
  }));
}

export async function repoCreateMatiereEtat(body: CreateMatiereEtatBodyDTO, audit: AuditContext): Promise<StockMatiereEtat> {
  const code = normalizeStockReferentialCode(body.code, "Etat");
  // La colonne historique `stock_etats.designation` est NOT NULL : une
  // désignation absente est stockée vide et ressort `null` côté API.
  const designation = body.designation?.trim() || "";
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
        details: { code, designation: designation || null, unite_achat, is_active, nuance_ids },
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
      designation: designation || null,
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
    etat_id: number | null;
    code: string;
    designation: string;
    informations: string | null;
    is_active: boolean;
  }>(
    `
      SELECT
        se.id::int AS id,
        se.etat_id::int AS etat_id,
        se.code,
        se.designation,
        se.informations,
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
  const etat_id = typeof body.etat_id === "number" ? Math.trunc(body.etat_id) : null;
  const code = normalizeStockReferentialCode(body.code, "Sous-etat");
  // Historical schema keeps this column NOT NULL while the API permits code-only values.
  const designation = body.designation?.trim() || "";
  const informations = body.informations?.trim() || null;
  const is_active = body.is_active;

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    let ins;
    try {
      ins = await client.query<StockMatiereSousEtat>(
        `
          INSERT INTO public.stock_sous_etats (etat_id, code, designation, informations, is_active)
          VALUES ($1::bigint,$2,$3,$4,$5)
          RETURNING id::int AS id, etat_id::int AS etat_id, code, designation, informations, is_active
        `,
        [etat_id, code, designation, informations, is_active]
      );
    } catch (err) {
      if (isPgUniqueViolation(err)) {
        throw new HttpError(409, "DUPLICATE_SOUS_ETAT", `Sous-etat ${code} already exists`);
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
        details: { etat_id, code, designation, informations, is_active },
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

type ReferentialPatch = Record<string, string | number | boolean | null | undefined>;

async function updateMatiereReferential<T>(args: {
  table: "stock_nuances" | "stock_etats" | "stock_sous_etats";
  id: number;
  patch: ReferentialPatch | ((previous: Record<string, unknown>) => ReferentialPatch);
  audit: AuditContext;
  action: string;
  read: (tx: Pick<PoolClient, "query">, id: number) => Promise<T | null>;
}): Promise<T | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    if (args.table === "stock_nuances") await client.query("SELECT pg_advisory_xact_lock(20261113, 84)");
    const before = await client.query<Record<string, unknown>>(
      `SELECT to_jsonb(r) AS row FROM public.${args.table} r WHERE r.id = $1 FOR UPDATE`, [args.id]
    );
    const previous = before.rows[0]?.row;
    if (!previous) {
      await client.query("ROLLBACK");
      return null;
    }

    const patch = typeof args.patch === "function" ? args.patch(previous as Record<string, unknown>) : args.patch;
    const values: unknown[] = [args.id];
    const assignments: string[] = [];
    for (const [column, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      values.push(value);
      assignments.push(`${column} = $${values.length}`);
    }
    assignments.push("updated_at = now()");
    await client.query(`UPDATE public.${args.table} SET ${assignments.join(", ")} WHERE id = $1`, values);
    const out = await args.read(client, args.id);
    if (!out) throw new Error(`Updated ${args.table} could not be read`);

    await repoInsertAuditLog({
      user_id: args.audit.user_id,
      body: {
        event_type: "ACTION", action: args.action, page_key: args.audit.page_key,
        entity_type: args.table, entity_id: String(args.id), path: args.audit.path,
        client_session_id: args.audit.client_session_id,
        details: { before: previous, patch },
      },
      ip: args.audit.ip, user_agent: args.audit.user_agent, device_type: args.audit.device_type,
      os: args.audit.os, browser: args.audit.browser, tx: client,
    });
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK");
    if (isPgUniqueViolation(err)) throw new HttpError(409, "DUPLICATE_REFERENTIAL_CODE", "Une valeur possède déjà ce code ou cette désignation. Consultez aussi les entrées inactives.");
    throw err;
  } finally {
    client.release();
  }
}

async function readMatiereNuanceTx(tx: Pick<PoolClient, "query">, id: number): Promise<StockMatiereNuance | null> {
  const res = await tx.query<Omit<StockMatiereNuance, "densite"> & { densite: string | number | null }>(`
    SELECT n.id::int AS id, n.code, n.designation, n.norme_fr, n.norme_en, n.norme_werkstoff, n.norme_usa, n.designation_principale,
      COALESCE(NULLIF(to_jsonb(n) ->> 'densite_kg_m3', '')::numeric, n.densite * 1000) AS densite,
      n.is_active, COALESCE(array_agg(ne.etat_id::int ORDER BY ne.etat_id) FILTER (WHERE ne.etat_id IS NOT NULL), ARRAY[]::int[]) AS etat_ids
    FROM public.stock_nuances n LEFT JOIN public.stock_nuance_etats ne ON ne.nuance_id=n.id
    WHERE n.id=$1 GROUP BY n.id`, [id]);
  const row = res.rows[0];
  return row ? { ...row, ...nuanceIdentity(row), designation: row.designation?.trim() || null, densite: row.densite === null ? null : Number(row.densite), etat_ids: row.etat_ids ?? [] } : null;
}

async function readMatiereEtatTx(tx: Pick<PoolClient, "query">, id: number): Promise<StockMatiereEtat | null> {
  const res = await tx.query<{ id: number; code: string; designation: string | null; unite_achat: number; is_active: boolean; nuance_ids: number[] }>(`
    SELECT e.id::int AS id, e.code, e.designation, e.unite_achat::int AS unite_achat, e.is_active,
      COALESCE(array_agg(ne.nuance_id::int ORDER BY ne.nuance_id) FILTER (WHERE ne.nuance_id IS NOT NULL), ARRAY[]::int[]) AS nuance_ids
    FROM public.stock_etats e LEFT JOIN public.stock_nuance_etats ne ON ne.etat_id=e.id
    WHERE e.id=$1 GROUP BY e.id`, [id]);
  const row = res.rows[0];
  return row ? { ...row, designation: row.designation?.trim() || null, nuance_ids: row.nuance_ids ?? [] } : null;
}

async function readMatiereSousEtatTx(tx: Pick<PoolClient, "query">, id: number): Promise<StockMatiereSousEtat | null> {
  const res = await tx.query<StockMatiereSousEtat>(`SELECT id::int AS id, etat_id::int AS etat_id, code, designation, informations, is_active FROM public.stock_sous_etats WHERE id=$1`, [id]);
  return res.rows[0] ?? null;
}

export function repoUpdateMatiereNuance(id: number, body: UpdateMatiereNuanceBodyDTO, audit: AuditContext) {
  return updateMatiereReferential({
    table: "stock_nuances", id, audit, action: "stock.matiere-nuances.update", read: readMatiereNuanceTx,
    patch: previous => {
      const identity = resolveNuanceIdentity(body, previous);
      const changesIdentity = nuanceNormeFields.some(key => body[key] !== undefined) || body.designation_principale !== undefined;
      if (body.code !== undefined && body.code !== previous.code && identity.designation_principale !== "LEGACY") {
        throw new HttpError(400, "NUANCE_CODE_IMMUTABLE", "Le code technique d’une nuance classée est conservé pour la traçabilité des articles.");
      }
      return {
        ...(changesIdentity ? Object.fromEntries([...nuanceNormeFields, "designation_principale" as const].map(key => [key, identity[key]])) : {}),
        code: body.code === undefined || body.code === previous.code ? undefined : normalizeStockReferentialCode(body.code, "Nuance"),
        designation: body.designation === undefined ? undefined : body.designation ?? "",
        densite: body.densite === undefined ? undefined : body.densite === null ? null : body.densite / 1000,
        is_active: body.is_active,
      };
    },
  });
}

export function repoUpdateMatiereEtat(id: number, body: UpdateMatiereEtatBodyDTO, audit: AuditContext) {
  return updateMatiereReferential({
    table: "stock_etats", id, audit, action: "stock.matiere-etats.update", read: readMatiereEtatTx,
    patch: { code: body.code === undefined ? undefined : normalizeStockReferentialCode(body.code, "Etat"), designation: body.designation === undefined ? undefined : body.designation ?? "", unite_achat: body.unite_achat, is_active: body.is_active },
  });
}

export function repoUpdateMatiereSousEtat(id: number, body: UpdateMatiereSousEtatBodyDTO, audit: AuditContext) {
  return updateMatiereReferential({
    table: "stock_sous_etats", id, audit, action: "stock.matiere-sous-etats.update", read: readMatiereSousEtatTx,
    patch: { code: body.code === undefined ? undefined : normalizeStockReferentialCode(body.code, "Sous-etat"), designation: body.designation === undefined ? undefined : body.designation ?? "", informations: body.informations === undefined ? undefined : body.informations?.trim() || null, is_active: body.is_active },
  });
}
