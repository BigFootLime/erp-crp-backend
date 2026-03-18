import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import type { PoolClient } from "pg";
import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { generateAffaireCode, requireClientCode } from "../../../shared/codes/code-generator.service";
import { emitAppNotificationCreated, emitEntityChanged } from "../../../shared/realtime/realtime.service";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import type { CreateAuditLogBodyDTO } from "../../audit-logs/validators/audit-logs.validators";
import { repoCreateAppNotifications, repoListUsersForCommandePlanningNotification } from "../../notifications/repository/notifications.repository";
import type { AppNotification } from "../../notifications/types/notifications.types";
import type {
  CreateCommandeInput,
  UploadedDocument,
  CommandeListItem,
  ClientLite,
} from "../types/commande-client.types";
import type {
  CommandesStockDecisionDTO,
  ConfirmGenerateAffairesBodyDTO,
  GenerateAffairesBodyDTO,
  GenerateAffairesV3BodyDTO,
  ListCommandesQueryDTO,
} from "../validators/commande-client.validators";

function normalizeStoredPath(filePath: string) {
  const rel = path.isAbsolute(filePath) ? path.relative(process.cwd(), filePath) : filePath;
  return rel.replace(/\\/g, "/");
}

function toInt(value: unknown, label = "id"): number {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  throw new Error(`Invalid ${label}: ${String(value)}`);
}

function toNullableInt(value: unknown, label = "id"): number | null {
  if (value === null || value === undefined) return null;
  return toInt(value, label);
}

function coerceOrderType(value: unknown): CreateCommandeInput["order_type"] {
  if (value === "FERME" || value === "CADRE" || value === "INTERNE") return value;
  if (typeof value === "string") {
    const v = value.trim().toUpperCase();
    if (v === "FERME" || v === "CADRE" || v === "INTERNE") return v as CreateCommandeInput["order_type"];
  }
  return "FERME";
}

function sortColumn(sortBy: ListCommandesQueryDTO["sortBy"]) {
  switch (sortBy) {
    case "numero":
      return "cc.numero";
    case "date_commande":
      return "cc.date_commande";
    case "updated_at":
      return "cc.updated_at";
    case "total_ttc":
      return "cc.total_ttc";
    default:
      return "cc.updated_at";
  }
}

function sortDirection(sortDir: ListCommandesQueryDTO["sortDir"]) {
  return sortDir === "asc" ? "ASC" : "DESC";
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

type Queryable = Pick<PoolClient, "query">;

type CommandeLineArticleResolution = {
  article_id: string;
  article_code: string;
  article_designation: string;
  article_unite: string | null;
  piece_technique_id: string | null;
  piece_code: string | null;
  piece_designation: string | null;
  stock_managed: boolean;
  is_active: boolean;
};

type AuditContext = {
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

type CommandeWorkflowStatus = "ENREGISTREE" | "PLANIFIEE" | "AR_ENVOYEE" | "LIVREE";

const commandeWorkflowOrder: Record<CommandeWorkflowStatus, number> = {
  ENREGISTREE: 0,
  PLANIFIEE: 1,
  AR_ENVOYEE: 2,
  LIVREE: 3,
};

async function insertAuditLog(tx: Queryable, audit: AuditContext, entry: {
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  details?: Record<string, unknown> | null;
}) {
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

async function insertCommandeEvent(db: Queryable, params: {
  commande_id: number;
  event_type: string;
  old_values?: unknown | null;
  new_values?: unknown | null;
  user_id?: number | null;
}) {
  await db.query(
    `
      INSERT INTO public.commande_client_event_log (
        commande_id,
        event_type,
        old_values,
        new_values,
        user_id
      ) VALUES ($1,$2,$3,$4,$5)
    `,
    [
      params.commande_id,
      params.event_type,
      params.old_values ? JSON.stringify(params.old_values) : null,
      params.new_values ? JSON.stringify(params.new_values) : null,
      params.user_id ?? null,
    ]
  );
}

async function resolveCommandeLineArticle(
  db: Queryable,
  line: CreateCommandeInput["lignes"][number]
): Promise<CommandeLineArticleResolution> {
  const requestedArticleId = typeof line.article_id === "string" && line.article_id.trim() ? line.article_id.trim() : null;
  const requestedCode = typeof line.code_piece === "string" && line.code_piece.trim() ? line.code_piece.trim() : null;

  if (!requestedArticleId && !requestedCode) {
    throw new HttpError(400, "ARTICLE_REQUIRED", "Each commande line must reference an article");
  }

  const res = await db.query<CommandeLineArticleResolution>(
    `
      SELECT
        a.id::text AS article_id,
        a.code AS article_code,
        a.designation AS article_designation,
        a.unite AS article_unite,
        a.piece_technique_id::text AS piece_technique_id,
        pt.code_piece AS piece_code,
        pt.designation AS piece_designation,
        a.stock_managed,
        a.is_active
      FROM public.articles a
      LEFT JOIN public.pieces_techniques pt ON pt.id = a.piece_technique_id
      WHERE ($1::uuid IS NOT NULL AND a.id = $1::uuid)
         OR ($2::text IS NOT NULL AND (a.code = $2 OR pt.code_piece = $2))
      ORDER BY
        CASE
          WHEN $1::uuid IS NOT NULL AND a.id = $1::uuid THEN 0
          WHEN $2::text IS NOT NULL AND a.code = $2 THEN 1
          WHEN $2::text IS NOT NULL AND pt.code_piece = $2 THEN 2
          ELSE 9
        END,
        a.updated_at DESC NULLS LAST,
        a.created_at DESC NULLS LAST,
        a.id ASC
      LIMIT 1
    `,
    [requestedArticleId, requestedCode]
  );

  const article = res.rows[0] ?? null;
  if (!article) {
    throw new HttpError(
      400,
      "INVALID_ARTICLE",
      requestedCode
        ? `Unknown article for reference ${requestedCode}`
        : `Unknown article_id ${requestedArticleId}`
    );
  }

  if (!article.is_active) {
    throw new HttpError(409, "ARTICLE_INACTIVE", `Article ${article.article_code} is inactive`);
  }

  if (!article.stock_managed) {
    throw new HttpError(409, "ARTICLE_NOT_STOCK_MANAGED", `Article ${article.article_code} is not stock-managed`);
  }

  if (!article.piece_technique_id) {
    throw new HttpError(
      409,
      "ARTICLE_PIECE_TECHNIQUE_REQUIRED",
      `Article ${article.article_code} must be linked to a piece technique before it can be sold`
    );
  }

  return article;
}

let commandeToAffaireHasRoleColumnCache: boolean | null = null;
async function hasCommandeToAffaireRoleColumn(db: Queryable): Promise<boolean> {
  if (commandeToAffaireHasRoleColumnCache !== null) return commandeToAffaireHasRoleColumnCache;

  const res = await db.query<{ ok: number }>(
    `
    SELECT 1::int AS ok
    FROM pg_attribute
    WHERE attrelid = to_regclass('public.commande_to_affaire')
      AND attname = 'role'
      AND NOT attisdropped
    LIMIT 1
    `
  );

  commandeToAffaireHasRoleColumnCache = res.rows.length > 0;
  return commandeToAffaireHasRoleColumnCache;
}

type CommandeToAffaireRole = "LIVRAISON" | null;
type CommandeToAffaireMapping = { affaire_id: number; role: CommandeToAffaireRole };

async function listCommandeToAffaireMappings(db: Queryable, commandeId: number): Promise<CommandeToAffaireMapping[]> {
  const hasRoleColumn = await hasCommandeToAffaireRoleColumn(db);
  const sql = hasRoleColumn
    ? `
      SELECT affaire_id::int AS affaire_id, role
      FROM commande_to_affaire
      WHERE commande_id = $1
      ORDER BY date_conversion DESC NULLS LAST, id DESC
      `
    : `
      SELECT
        affaire_id::int AS affaire_id,
        'LIVRAISON' AS role
      FROM commande_to_affaire
      WHERE commande_id = $1
      ORDER BY id ASC
      `;

  const res = await db.query<{ affaire_id: number; role: string | null }>(sql, [commandeId]);
  return res.rows.map((r) => ({
    affaire_id: r.affaire_id,
    role: r.role === "LIVRAISON" ? r.role : null,
  }));
}

type StockOnHandSource = {
  table: string;
  alias: string;
  articleIdColumn: string;
  qtyOnHandColumn: string;
};

let stockOnHandSourceCache: StockOnHandSource | null | undefined = undefined;
async function resolveStockOnHandSource(db: Queryable): Promise<StockOnHandSource | null> {
  if (stockOnHandSourceCache !== undefined) return stockOnHandSourceCache;

  const candidates: Array<{
    table: string;
    alias: string;
    articleIdColumns: readonly string[];
    qtyColumns: readonly string[];
  }> = [
    {
      table: "public.stock_balances",
      alias: "sb",
      articleIdColumns: ["article_id", "article_ref_id"],
      qtyColumns: [
        "qty_on_hand",
        "quantity_on_hand",
        "qty",
        "quantity",
        "qty_available",
        "available_qty",
      ],
    },
    {
      table: "public.stock_levels",
      alias: "sl",
      articleIdColumns: ["article_id", "article_ref_id"],
      qtyColumns: [
        "qty_on_hand",
        "quantity_on_hand",
        "qty",
        "quantity",
        "qty_available",
        "available_qty",
      ],
    },
  ];

  for (const c of candidates) {
    const colsRes = await db.query<{ name: string }>(
      `
      SELECT attname AS name
      FROM pg_attribute
      WHERE attrelid = to_regclass($1)
        AND attnum > 0
        AND NOT attisdropped
      `,
      [c.table]
    );

    if (colsRes.rows.length === 0) continue;
    const cols = new Set(colsRes.rows.map((r) => r.name));

    const articleIdColumn = c.articleIdColumns.find((n) => cols.has(n)) ?? null;
    const qtyOnHandColumn = c.qtyColumns.find((n) => cols.has(n)) ?? null;

    if (!articleIdColumn || !qtyOnHandColumn) continue;

    stockOnHandSourceCache = {
      table: c.table,
      alias: c.alias,
      articleIdColumn,
      qtyOnHandColumn,
    };
    return stockOnHandSourceCache;
  }

  stockOnHandSourceCache = null;
  return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeCommandeWorkflowStatus(value: unknown): CommandeWorkflowStatus | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  if (normalized === "ENREGISTREE" || normalized === "PLANIFIEE" || normalized === "AR_ENVOYEE" || normalized === "LIVREE") {
    return normalized;
  }
  return null;
}

async function getDefaultShippingLocation(db: Queryable): Promise<{
  magasin_id: string;
  emplacement_id: number;
  location_id: string;
}> {
  const setting = await db.query<{ value_json: unknown }>(
    `SELECT value_json FROM public.erp_settings WHERE key = $1 LIMIT 1`,
    ["stock.default_shipping_location"]
  );

  const raw = setting.rows[0]?.value_json ?? null;
  if (!isObject(raw)) {
    throw new HttpError(
      500,
      "DEFAULT_SHIPPING_LOCATION_NOT_CONFIGURED",
      "Missing erp_settings key 'stock.default_shipping_location'"
    );
  }

  const magasin_id = typeof raw.magasin_id === "string" ? raw.magasin_id : null;
  const emplacement_id =
    typeof raw.emplacement_id === "number"
      ? raw.emplacement_id
      : typeof raw.emplacement_id === "string" && /^\d+$/.test(raw.emplacement_id)
        ? Number(raw.emplacement_id)
        : null;

  if (!magasin_id || typeof emplacement_id !== "number" || !Number.isFinite(emplacement_id)) {
    throw new HttpError(
      500,
      "DEFAULT_SHIPPING_LOCATION_NOT_CONFIGURED",
      "Invalid format for erp_settings 'stock.default_shipping_location' (expected {magasin_id, emplacement_id})"
    );
  }

  const location_id = await resolveLocationIdForEmplacement(db, {
    magasin_id,
    emplacement_id,
    label: "default_shipping_location",
  });

  return { magasin_id, emplacement_id, location_id };
}

async function resolveLocationIdForEmplacement(
  db: Queryable,
  params: { magasin_id: string; emplacement_id: number; label: string }
): Promise<string> {
  const map = await db.query<{ location_id: string }>(
    `
      SELECT location_id::text AS location_id
      FROM public.emplacements
      WHERE magasin_id = $1::uuid
        AND id = $2::bigint
      LIMIT 1
    `,
    [params.magasin_id, params.emplacement_id]
  );

  const location_id = map.rows[0]?.location_id ?? null;
  if (!location_id) {
    throw new HttpError(500, "INVALID_LOCATION", `Invalid magasin/emplacement mapping for ${params.label}`);
  }

  return location_id;
}

async function getInternalClientIdSetting(db: Queryable): Promise<string | null> {
  const res = await db.query<{ value_text: string | null }>(
    `SELECT value_text FROM public.erp_settings WHERE key = $1 LIMIT 1`,
    ["commandes.internal_client_id"]
  );
  const v = (res.rows[0]?.value_text ?? "").trim();
  return v.length > 0 ? v : null;
}

type ListWhere = { whereSql: string; values: unknown[] };

function normalizedCommandeStatusSql(rawExpr: string): string {
  return `
    CASE
      WHEN ${rawExpr} IS NULL THEN 'ENREGISTREE'
      WHEN ${rawExpr} IN ('ENREGISTREE','PLANIFIEE','AR_ENVOYEE','LIVREE') THEN ${rawExpr}
      WHEN lower(${rawExpr}) IN ('brouillon','envoyée','envoyee','confirmée','confirmee') THEN 'ENREGISTREE'
      WHEN lower(${rawExpr}) IN ('en préparation','en preparation','en production') THEN 'PLANIFIEE'
      WHEN lower(${rawExpr}) IN ('partielle') THEN 'AR_ENVOYEE'
      WHEN lower(${rawExpr}) IN ('livrée','livree','facturée','facturee','clôturée','cloturee') THEN 'LIVREE'
      ELSE 'ENREGISTREE'
    END
  `;
}

function buildListWhere(filters: ListCommandesQueryDTO): ListWhere {
  const where: string[] = [];
  const values: unknown[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  if (filters.q && filters.q.trim().length > 0) {
    const p = push(`%${filters.q.trim()}%`);
    where.push(`(cc.numero ILIKE ${p} OR c.company_name ILIKE ${p} OR cc.code_client ILIKE ${p})`);
  }

  if (filters.client_id && filters.client_id.trim().length > 0) {
    const p = push(filters.client_id.trim());
    where.push(`cc.client_id = ${p}`);
  }

  if (filters.statut && filters.statut.trim().length > 0) {
    const p = push(filters.statut.trim());
    where.push(`(${normalizedCommandeStatusSql("st.nouveau_statut")}) = ${p}`);
  }

  if (filters.order_type) {
    const p = push(filters.order_type);
    where.push(`cc.order_type = ${p}`);
  }

  if (filters.from && filters.from.trim().length > 0) {
    const p = push(filters.from.trim());
    where.push(`cc.date_commande >= ${p}::date`);
  }

  if (filters.to && filters.to.trim().length > 0) {
    const p = push(filters.to.trim());
    where.push(`cc.date_commande <= ${p}::date`);
  }

  if (typeof filters.min_total_ttc === "number" && Number.isFinite(filters.min_total_ttc)) {
    const p = push(filters.min_total_ttc);
    where.push(`cc.total_ttc >= ${p}`);
  }

  if (typeof filters.max_total_ttc === "number" && Number.isFinite(filters.max_total_ttc)) {
    const p = push(filters.max_total_ttc);
    where.push(`cc.total_ttc <= ${p}`);
  }

  if (filters.mine_recent) {
    where.push(`cc.updated_at >= (now() - interval '30 days')`);
  }

  return {
    whereSql: where.length ? `WHERE ${where.join(" AND ")}` : "",
    values,
  };
}

async function loadCommandeWorkflowHeader(tx: Queryable, commandeId: number): Promise<{
  id: number;
  numero: string;
  client_id: string | null;
} | null> {
  const res = await tx.query<{ id: number; numero: string; client_id: string | null }>(
    `
      SELECT id::int AS id, numero, client_id
      FROM commande_client
      WHERE id = $1
      LIMIT 1
    `,
    [commandeId]
  );

  return res.rows[0] ?? null;
}

export async function repoEnsureCommandeWorkflowStatus(params: {
  tx: Queryable;
  commande_id: number;
  nouveau_statut: string;
  commentaire: string | null;
  user_id: number | null;
}): Promise<{
  changed: boolean;
  ancien_statut: string | null;
  nouveau_statut: string;
  history_id: number | null;
  notifications: AppNotification[];
}> {
  const commande = await loadCommandeWorkflowHeader(params.tx, params.commande_id);
  if (!commande) {
    throw new HttpError(404, "COMMANDE_NOT_FOUND", "Commande introuvable");
  }

  const nextRaw = params.nouveau_statut.trim();
  const nextNormalized = normalizeCommandeWorkflowStatus(nextRaw);

  const last = await params.tx.query<{ nouveau_statut: string }>(
    `
      SELECT nouveau_statut
      FROM commande_historique
      WHERE commande_id = $1
      ORDER BY date_action DESC, id DESC
      LIMIT 1
    `,
    [params.commande_id]
  );

  const ancienStatut = last.rows[0]?.nouveau_statut ?? null;
  const currentNormalized = normalizeCommandeWorkflowStatus(ancienStatut);

  if (ancienStatut && ancienStatut.trim().toUpperCase() === nextRaw.toUpperCase()) {
    return {
      changed: false,
      ancien_statut: ancienStatut,
      nouveau_statut: ancienStatut,
      history_id: null,
      notifications: [],
    };
  }

  if (
    currentNormalized &&
    nextNormalized &&
    commandeWorkflowOrder[nextNormalized] < commandeWorkflowOrder[currentNormalized]
  ) {
    return {
      changed: false,
      ancien_statut: ancienStatut,
      nouveau_statut: ancienStatut ?? nextRaw,
      history_id: null,
      notifications: [],
    };
  }

  const ins = await params.tx.query<{ id: string }>(
    `
      INSERT INTO commande_historique (commande_id, user_id, ancien_statut, nouveau_statut, commentaire)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id::text AS id
    `,
    [params.commande_id, params.user_id, ancienStatut, nextRaw, params.commentaire]
  );

  if (nextNormalized === "AR_ENVOYEE") {
    await params.tx.query(
      `UPDATE commande_client SET updated_at = now(), arc_date_envoi = COALESCE(arc_date_envoi, now()) WHERE id = $1`,
      [params.commande_id]
    );
  } else {
    await params.tx.query(`UPDATE commande_client SET updated_at = now() WHERE id = $1`, [params.commande_id]);
  }

  await insertCommandeEvent(params.tx, {
    commande_id: params.commande_id,
    event_type: "STATUS_CHANGED",
    old_values: { ancien_statut: ancienStatut },
    new_values: { nouveau_statut: nextRaw },
    user_id: params.user_id ?? null,
  });

  let notifications: AppNotification[] = [];
  if (nextNormalized === "PLANIFIEE") {
    const recipientIds = await repoListUsersForCommandePlanningNotification(params.tx);
    notifications = await repoCreateAppNotifications({
      tx: params.tx,
      user_ids: recipientIds,
      kind: "commande.planifiee",
      title: `Commande ${commande.numero} planifiée`,
      message: `La commande ${commande.numero} est maintenant planifiée. Un AR peut être envoyé au client.`,
      severity: "success",
      action_url: `/commandes/${params.commande_id}`,
      action_label: "Ouvrir",
      payload: {
        commande_id: params.commande_id,
        numero: commande.numero,
        client_id: commande.client_id,
      },
      dedupe_key: `commande:${params.commande_id}:planifiee`,
    });
  }

  return {
    changed: true,
    ancien_statut: ancienStatut,
    nouveau_statut: nextRaw,
    history_id: ins.rows[0]?.id ? toInt(ins.rows[0].id, "commande_historique.id") : null,
    notifications,
  };
}

export async function repoListCommandes(filters: ListCommandesQueryDTO) {
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 20;
  const offset = (page - 1) * pageSize;

  const { whereSql, values } = buildListWhere(filters);
  const orderBy = sortColumn(filters.sortBy);
  const orderDir = sortDirection(filters.sortDir);

  const countSql = `
    SELECT COUNT(*)::int AS total
    FROM commande_client cc
    LEFT JOIN clients c ON c.client_id = cc.client_id
    LEFT JOIN LATERAL (
      SELECT ch.nouveau_statut
      FROM commande_historique ch
      WHERE ch.commande_id = cc.id
      ORDER BY ch.date_action DESC, ch.id DESC
      LIMIT 1
    ) st ON TRUE
    ${whereSql}
  `;
  const countRes = await pool.query<{ total: number }>(countSql, values);
  const total = countRes.rows[0]?.total ?? 0;

  const dataSql = `
    SELECT
      cc.id::text AS id,
      cc.numero,
      cc.client_id,
      cc.order_type,
      cc.date_commande::text AS date_commande,
      cc.total_ht::float8 AS total_ht,
      cc.total_ttc::float8 AS total_ttc,
      cc.updated_at::text AS updated_at,
      ${normalizedCommandeStatusSql("st.nouveau_statut")} AS statut,
      CASE WHEN c.client_id IS NULL THEN NULL ELSE jsonb_build_object(
        'client_id', c.client_id,
        'company_name', c.company_name,
        'email', c.email,
        'phone', c.phone,
        'delivery_address_id', c.delivery_address_id::text,
        'bill_address_id', c.bill_address_id::text
      ) END AS client
    FROM commande_client cc
    LEFT JOIN clients c ON c.client_id = cc.client_id
    LEFT JOIN LATERAL (
      SELECT ch.nouveau_statut
      FROM commande_historique ch
      WHERE ch.commande_id = cc.id
      ORDER BY ch.date_action DESC, ch.id DESC
      LIMIT 1
    ) st ON TRUE
    ${whereSql}
    ORDER BY ${orderBy} ${orderDir}
    LIMIT $${values.length + 1}
    OFFSET $${values.length + 2}
  `;
  const dataValues = [...values, pageSize, offset];
  type CommandeListRow = Omit<CommandeListItem, "id"> & {
    id: string;
    client: ClientLite | null;
  };

  const dataRes = await pool.query<CommandeListRow>(dataSql, dataValues);

  const items = dataRes.rows.map((r) => ({
    ...r,
    id: toInt(r.id, "id"),
  }));

  return { items, total };
}

type IncludeFlags = {
  lignes: boolean;
  echeances: boolean;
  documents: boolean;
  historique: boolean;
  affaires: boolean;
  client: boolean;
};

function includeFlags(includes: Set<string>): IncludeFlags {
  const has = (v: string) => includes.has(v);
  return {
    lignes: has("lignes"),
    echeances: has("echeances"),
    documents: has("documents"),
    historique: has("historique"),
    affaires: has("affaires"),
    client: has("client"),
  };
}

export async function repoGetCommande(id: string, includes: Set<string>) {
  const commandeId = toInt(id, "commande_id");

  const headerSql = `
    SELECT
      cc.id::text AS id,
      cc.numero,
      cc.client_id,
      cc.contact_id::text AS contact_id,
      cc.destinataire_id::text AS destinataire_id,
      cc.adresse_facturation_id::text AS adresse_facturation_id,
      cc.emetteur,
      cc.code_client,
      cc.date_commande::text AS date_commande,
      cc.arc_edi,
      cc.arc_date_envoi::text AS arc_date_envoi,
      cc.compteur_affaire_id::text AS compteur_affaire_id,
      cc.type_affaire,
      cc.order_type,
      cc.cadre_start_date::text AS cadre_start_date,
      cc.cadre_end_date::text AS cadre_end_date,
      cc.dest_stock_magasin_id::text AS dest_stock_magasin_id,
      cc.dest_stock_emplacement_id::text AS dest_stock_emplacement_id,
      cc.mode_port_id::text AS mode_port_id,
      cc.mode_reglement_id::text AS mode_reglement_id,
      cc.conditions_paiement_id,
      cc.biller_id::text AS biller_id,
      cc.compte_vente_id::text AS compte_vente_id,
      cc.commentaire,
      cc.remise_globale::float8 AS remise_globale,
      cc.total_ht::float8 AS total_ht,
      cc.total_ttc::float8 AS total_ttc,
      cc.created_at::text AS created_at,
      cc.updated_at::text AS updated_at,
      ${normalizedCommandeStatusSql("st.nouveau_statut")} AS statut
    FROM commande_client cc
    LEFT JOIN LATERAL (
      SELECT ch.nouveau_statut
      FROM commande_historique ch
      WHERE ch.commande_id = cc.id
      ORDER BY ch.date_action DESC, ch.id DESC
      LIMIT 1
    ) st ON TRUE
    WHERE cc.id = $1
  `;
  type HeaderRow = {
    id: string;
    numero: string;
    client_id: string | null;
    contact_id: string | null;
    destinataire_id: string | null;
    adresse_facturation_id: string | null;
    emetteur: string | null;
    code_client: string | null;
    date_commande: string;
    arc_edi: boolean;
    arc_date_envoi: string | null;
    compteur_affaire_id: string | null;
    type_affaire: string;
    order_type: string;
    cadre_start_date: string | null;
    cadre_end_date: string | null;
    dest_stock_magasin_id: string | null;
    dest_stock_emplacement_id: string | null;
    mode_port_id: string | null;
    mode_reglement_id: string | null;
    conditions_paiement_id: number | null;
    biller_id: string | null;
    compte_vente_id: string | null;
    commentaire: string | null;
    remise_globale: number;
    total_ht: number;
    total_ttc: number;
    created_at: string;
    updated_at: string;
    statut: string;
  };

  const headerRes = await pool.query<HeaderRow>(headerSql, [commandeId]);
  const commandeRow = headerRes.rows[0] ?? null;
  if (!commandeRow) return null;

  const commande = {
    ...commandeRow,
    id: toInt(commandeRow.id, "commande.id"),
  };

  const inc = includeFlags(includes);

  const lignes = inc.lignes
    ? (
        await pool.query(
          `
          SELECT
            cl.id::text AS id,
            cl.commande_id::text AS commande_id,
            cl.designation,
            COALESCE(a.code, cl.code_piece) AS code_piece,
            cl.article_id::text AS article_id,
            COALESCE(cl.piece_technique_id::text, a.piece_technique_id::text) AS piece_technique_id,
            cl.quantite::float8 AS quantite,
            cl.unite,
            cl.prix_unitaire_ht::float8 AS prix_unitaire_ht,
            cl.remise_ligne::float8 AS remise_ligne,
            cl.taux_tva::float8 AS taux_tva,
            cl.delai_client::text AS delai_client,
            cl.delai_interne::text AS delai_interne,
            cl.total_ht::float8 AS total_ht,
            cl.total_ttc::float8 AS total_ttc,
            cl.devis_numero,
            cl.famille
          FROM commande_ligne cl
          LEFT JOIN public.articles a ON a.id = cl.article_id
          WHERE cl.commande_id = $1
          ORDER BY cl.id ASC
          `,
          [commandeId]
        )
      ).rows
    : [];

  const lignesOut = lignes.map((l: any) => ({
    ...l,
    id: toInt(l.id, "lignes.id"),
    commande_id: toInt(l.commande_id, "lignes.commande_id"),
  }));

  const echeances = inc.echeances
    ? (
        await pool.query(
          `
          SELECT
            id::text AS id,
            commande_id::text AS commande_id,
            libelle,
            date_echeance::text AS date_echeance,
            pourcentage::float8 AS pourcentage,
            montant::float8 AS montant
          FROM commande_echeance
          WHERE commande_id = $1
          ORDER BY date_echeance ASC, id ASC
          `,
          [commandeId]
        )
      ).rows
    : [];

  const echeancesOut = echeances.map((e: any) => ({
    ...e,
    id: toInt(e.id, "echeances.id"),
    commande_id: toInt(e.commande_id, "echeances.commande_id"),
  }));

  const documents = inc.documents
    ? (
        await pool.query(
          `
          SELECT
            cd.id::text AS id,
            cd.commande_id::text AS commande_id,
            cd.document_id::text AS document_id,
            cd.type,
            CASE WHEN dc.id IS NULL THEN NULL ELSE jsonb_build_object(
              'id', dc.id::text,
              'document_name', dc.document_name,
              'type', dc.type,
              'creation_date', dc.creation_date::text,
              'created_by', dc.created_by
            ) END AS document
          FROM commande_documents cd
          LEFT JOIN documents_clients dc ON dc.id = cd.document_id
          WHERE cd.commande_id = $1
          ORDER BY cd.id DESC
          `,
          [commandeId]
        )
      ).rows
    : [];

  const documentsOut = documents.map((d: any) => ({
    ...d,
    id: toInt(d.id, "documents.id"),
    commande_id: toInt(d.commande_id, "documents.commande_id"),
  }));

  const historique = inc.historique
    ? (
        await pool.query(
          `
          SELECT
            id::text AS id,
            commande_id::text AS commande_id,
            user_id,
            date_action::text AS date_action,
            ancien_statut,
            nouveau_statut,
            commentaire
          FROM commande_historique
          WHERE commande_id = $1
          ORDER BY date_action DESC, id DESC
          `,
          [commandeId]
        )
      ).rows
    : [];

  const historiqueOut = historique.map((h: any) => ({
    ...h,
    id: toInt(h.id, "historique.id"),
    commande_id: toInt(h.commande_id, "historique.commande_id"),
    user_id: toNullableInt(h.user_id, "historique.user_id"),
  }));

  let affaires: any[] = [];
  if (inc.affaires) {
    const hasRoleColumn = await hasCommandeToAffaireRoleColumn(pool);
    const roleSql = hasRoleColumn
      ? "cta.role AS role"
      : `
        CASE
          WHEN row_number() OVER (PARTITION BY cta.commande_id ORDER BY cta.id ASC) = 1 THEN 'LIVRAISON'
          WHEN row_number() OVER (PARTITION BY cta.commande_id ORDER BY cta.id ASC) = 2 THEN 'PRODUCTION'
          ELSE NULL
        END AS role
      `;

    affaires = (
      await pool.query(
        `
         SELECT
           cta.id::text AS id,
           cta.commande_id::text AS commande_id,
           cta.affaire_id::text AS affaire_id,
           cta.date_conversion::text AS date_conversion,
           cta.commentaire,
           ${roleSql},
           jsonb_build_object(
             'id', a.id,
             'reference', a.reference,
             'client_id', a.client_id,
             'commande_id', a.commande_id,
            'devis_id', a.devis_id,
            'type_affaire', a.type_affaire,
            'statut', a.statut,
            'date_ouverture', a.date_ouverture::text,
            'date_cloture', a.date_cloture::text,
            'commentaire', a.commentaire,
            'created_at', a.created_at::text,
            'updated_at', a.updated_at::text
          ) AS affaire
        FROM commande_to_affaire cta
        JOIN affaire a ON a.id = cta.affaire_id
        WHERE cta.commande_id = $1
        ORDER BY cta.date_conversion DESC, cta.id DESC
        `,
        [commandeId]
      )
    ).rows;
  }

  const affairesOut = affaires.map((a: any) => {
    const affaireValue: unknown = a.affaire;
    const affaireOut =
      affaireValue && typeof affaireValue === "object" && !Array.isArray(affaireValue)
        ? (() => {
            const rec = affaireValue as Record<string, unknown>;
            return {
              ...rec,
              id: toInt(rec.id, "affaires.affaire.id"),
              commande_id: toNullableInt(rec.commande_id, "affaires.affaire.commande_id"),
              devis_id: toNullableInt(rec.devis_id, "affaires.affaire.devis_id"),
            };
          })()
        : affaireValue;

    return {
      ...a,
      id: toInt(a.id, "affaires.id"),
      commande_id: toInt(a.commande_id, "affaires.commande_id"),
      affaire_id: toInt(a.affaire_id, "affaires.affaire_id"),
      affaire: affaireOut,
    };
  });

  const client = inc.client
    ? commande.client_id
      ? (
          await pool.query(
            `
            SELECT
              client_id,
              company_name,
              email,
              phone,
              delivery_address_id::text AS delivery_address_id,
              bill_address_id::text AS bill_address_id
            FROM clients
            WHERE client_id = $1
            `,
            [commande.client_id]
          )
        ).rows[0] ?? null
      : null
    : null;

  return {
    commande,
    lignes: lignesOut,
    echeances: echeancesOut,
    documents: documentsOut,
    historique: historiqueOut,
    affaires: affairesOut,
    client,
  };
}

export type CommandeDocumentFileMeta = {
  id: string;
  document_name: string;
  type: string | null;
};

export async function repoGetCommandeDocumentFileMeta(commandeId: string, docId: string): Promise<CommandeDocumentFileMeta | null> {
  const id = toInt(commandeId, "commande_id");

  const sql = `
    SELECT
      dc.id::text AS id,
      dc.document_name,
      dc.type
    FROM commande_documents cd
    JOIN documents_clients dc ON dc.id = cd.document_id
    WHERE cd.commande_id = $1
      AND cd.document_id = $2
    LIMIT 1
  `;

  const res = await pool.query<CommandeDocumentFileMeta>(sql, [id, docId]);
  return res.rows[0] ?? null;
}

async function insertCommandeLignes(client: PoolClient, commandeId: string, lignes: CreateCommandeInput["lignes"]) {
  if (!lignes.length) return;

  for (const l of lignes) {
    const resolved = await resolveCommandeLineArticle(client, l);
    const designation = typeof l.designation === "string" && l.designation.trim().length > 0
      ? l.designation.trim()
      : resolved.article_designation;
    const unite = typeof l.unite === "string" && l.unite.trim().length > 0
      ? l.unite.trim()
      : resolved.article_unite;

    await client.query(
      `
        INSERT INTO commande_ligne (
          commande_id,
          article_id,
          piece_technique_id,
          designation,
          code_piece,
          quantite,
          unite,
          prix_unitaire_ht,
          remise_ligne,
          taux_tva,
          delai_client,
          delai_interne,
          devis_numero,
          famille
        ) VALUES (
          $1,
          $2::uuid,
          $3::uuid,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10,
          $11,
          $12,
          $13,
          $14
        )
      `,
      [
        commandeId,
        resolved.article_id,
        resolved.piece_technique_id,
        designation,
        resolved.article_code,
        l.quantite,
        unite ?? null,
        l.prix_unitaire_ht,
        l.remise_ligne ?? 0,
        l.taux_tva ?? 20,
        l.delai_client ?? null,
        l.delai_interne ?? null,
        l.devis_numero ?? null,
        l.famille ?? null,
      ]
    );
  }
}

async function insertCommandeEcheances(
  client: PoolClient,
  commandeId: string,
  echeances: NonNullable<CreateCommandeInput["echeances"]>
) {
  if (!echeances.length) return;

  const params: unknown[] = [commandeId];
  const valuesSql: string[] = [];
  for (const e of echeances) {
    const baseIndex = params.length;
    params.push(e.libelle, e.date_echeance, e.pourcentage, e.montant);
    const placeholders = Array.from({ length: 4 }, (_, j) => `$${baseIndex + 1 + j}`).join(",");
    valuesSql.push(`($1,${placeholders})`);
  }

  await client.query(
    `
    INSERT INTO commande_echeance (
      commande_id,
      libelle,
      date_echeance,
      pourcentage,
      montant
    ) VALUES ${valuesSql.join(",")}
    `,
    params
  );
}

async function insertCommandeDocuments(client: PoolClient, commandeId: string, documents: UploadedDocument[]) {
  if (!documents.length) return;

  for (const doc of documents) {
    const documentId = crypto.randomUUID();
    const isPdf = doc.originalname.toLowerCase().endsWith(".pdf");
    const docType = isPdf ? "PDF" : doc.mimetype;

    const extCandidate = path.extname(doc.originalname).toLowerCase();
    const safeExt = /^\.[a-z0-9]+$/.test(extCandidate) && extCandidate.length <= 10 ? extCandidate : "";

    const uploadDir = path.resolve("uploads/docs");
    const finalPath = path.join(uploadDir, `${documentId}${safeExt}`);

    try {
      await fs.rename(doc.path, finalPath);
    } catch {
      // Fallback for cross-device issues
      await fs.copyFile(doc.path, finalPath);
      await fs.unlink(doc.path);
    }

    await client.query(
      `
      INSERT INTO documents_clients (id, document_name, type)
      VALUES ($1, $2, $3)
      `,
      [documentId, doc.originalname, docType]
    );

    await client.query(
      `
      INSERT INTO commande_documents (commande_id, document_id, type)
      VALUES ($1, $2, $3)
      `,
      [commandeId, documentId, isPdf ? "PDF" : null]
    );
  }
}

export async function repoCreateCommande(input: CreateCommandeInput, documents: UploadedDocument[]) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const idRes = await client.query<{ id: string }>(
      `SELECT nextval('public.commande_client_id_seq')::bigint::text AS id`
    );
    const rawId = idRes.rows[0]?.id;
    if (!rawId) throw new Error("Failed to allocate commande id");
    const commandeIdInt = toInt(rawId, "commande_client.id");

    const numero = typeof input.numero === "string" && input.numero.trim().length > 0 ? input.numero.trim() : null;
    const numeroForInsert = numero ?? `CC-${commandeIdInt}`.slice(0, 30);

    const orderType = input.order_type ?? "FERME";

    const insertSql = `
      INSERT INTO commande_client (
        id,
        numero,
        client_id,
        contact_id,
        destinataire_id,
        adresse_facturation_id,
        emetteur,
        code_client,
        date_commande,
        arc_edi,
        arc_date_envoi,
        compteur_affaire_id,
        type_affaire,
        order_type,
        cadre_start_date,
        cadre_end_date,
        dest_stock_magasin_id,
        dest_stock_emplacement_id,
        mode_port_id,
        mode_reglement_id,
        conditions_paiement_id,
        biller_id,
        compte_vente_id,
        commentaire,
        remise_globale,
        total_ht,
        total_ttc
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27
      )
      RETURNING id::text AS id
    `;
    const insertParams = [
      commandeIdInt,
      numeroForInsert,
      input.client_id ?? null,
      input.contact_id ?? null,
      input.destinataire_id ?? null,
      input.adresse_facturation_id ?? null,
      input.emetteur ?? null,
      input.code_client ?? null,
      input.date_commande,
      input.arc_edi ?? false,
      input.arc_date_envoi ?? null,
      input.compteur_affaire_id ?? null,
      "livraison",
      orderType,
      input.cadre_start_date ?? null,
      input.cadre_end_date ?? null,
      input.dest_stock_magasin_id ?? null,
      input.dest_stock_emplacement_id ?? null,
      input.mode_port_id ?? null,
      input.mode_reglement_id ?? null,
      input.conditions_paiement_id ?? null,
      input.biller_id ?? null,
      input.compte_vente_id ?? null,
      input.commentaire ?? null,
      input.remise_globale ?? 0,
      input.total_ht ?? 0,
      input.total_ttc ?? 0,
    ];
    const ins = await client.query<{ id: string }>(insertSql, insertParams);
    const commandeId = ins.rows[0]?.id;
    if (!commandeId) throw new Error("Failed to create commande");

    await insertCommandeLignes(client, commandeId, input.lignes);
    await insertCommandeEcheances(client, commandeId, input.echeances ?? []);
    await insertCommandeDocuments(client, commandeId, documents);

    // Initial workflow status: ENREGISTREE
    await client.query(
      `
        INSERT INTO commande_historique (commande_id, user_id, ancien_statut, nouveau_statut, commentaire)
        VALUES ($1, $2, $3, $4, $5)
      `,
      [commandeIdInt, null, null, "ENREGISTREE", "Commande créée"]
    );

    await client.query("COMMIT");
    return { id: toInt(commandeId, "commande.id") };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function repoUpdateCommande(id: string, input: CreateCommandeInput, documents: UploadedDocument[]) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const existingRes = await client.query<{
      numero: string;
      client_id: string | null;
      order_type: string;
      adresse_facturation_id: string | null;
      cadre_start_date: string | null;
      cadre_end_date: string | null;
      dest_stock_magasin_id: string | null;
      dest_stock_emplacement_id: string | null;
      ar_sent_at: string | null;
    }>(
      `
      SELECT
        numero,
        client_id,
        order_type,
        adresse_facturation_id::text AS adresse_facturation_id,
        cadre_start_date::text AS cadre_start_date,
        cadre_end_date::text AS cadre_end_date,
        dest_stock_magasin_id::text AS dest_stock_magasin_id,
        dest_stock_emplacement_id::text AS dest_stock_emplacement_id,
        ar_sent_at::text AS ar_sent_at
      FROM commande_client
      WHERE id = $1::bigint
      FOR UPDATE
      `,
      [id]
    );
    const existing = existingRes.rows[0] ?? null;
    if (!existing) {
      await client.query("ROLLBACK");
      return null;
    }

    if (existing.ar_sent_at) {
      throw new HttpError(409, "COMMANDE_LOCKED_AFTER_AR", "Commande is locked after AR has been sent");
    }

    const numero = typeof input.numero === "string" && input.numero.trim().length > 0 ? input.numero.trim() : existing.numero;
    const orderType = input.order_type ?? coerceOrderType(existing.order_type);

    const clientIdForUpdate = hasOwn(input as object, "client_id") ? (input.client_id ?? null) : existing.client_id;
    const adresseFacturationForUpdate = hasOwn(input as object, "adresse_facturation_id")
      ? (input.adresse_facturation_id ?? null)
      : existing.adresse_facturation_id;
    const cadreStartForUpdate = hasOwn(input as object, "cadre_start_date")
      ? (input.cadre_start_date ?? null)
      : existing.cadre_start_date;
    const cadreEndForUpdate = hasOwn(input as object, "cadre_end_date")
      ? (input.cadre_end_date ?? null)
      : existing.cadre_end_date;
    const destMagasinForUpdate = hasOwn(input as object, "dest_stock_magasin_id")
      ? (input.dest_stock_magasin_id ?? null)
      : existing.dest_stock_magasin_id;
    const destEmplacementForUpdate = hasOwn(input as object, "dest_stock_emplacement_id")
      ? (input.dest_stock_emplacement_id ?? null)
      : existing.dest_stock_emplacement_id;

    const updateSql = `
      UPDATE commande_client
      SET
        numero = $2,
        client_id = $3,
        contact_id = $4,
        destinataire_id = $5,
        adresse_facturation_id = $6,
        emetteur = $7,
        code_client = $8,
        date_commande = $9,
        arc_edi = $10,
        arc_date_envoi = $11,
        compteur_affaire_id = $12,
        type_affaire = $13,
        order_type = $14,
        cadre_start_date = $15,
        cadre_end_date = $16,
        dest_stock_magasin_id = $17,
        dest_stock_emplacement_id = $18,
        mode_port_id = $19,
        mode_reglement_id = $20,
        conditions_paiement_id = $21,
        biller_id = $22,
        compte_vente_id = $23,
        commentaire = $24,
        remise_globale = $25,
        total_ht = $26,
        total_ttc = $27,
        updated_at = now()
      WHERE id = $1
      RETURNING id::text AS id
    `;
    const updateParams = [
      id,
      numero,
      clientIdForUpdate,
      input.contact_id ?? null,
      input.destinataire_id ?? null,
      adresseFacturationForUpdate,
      input.emetteur ?? null,
      input.code_client ?? null,
      input.date_commande,
      input.arc_edi ?? false,
      input.arc_date_envoi ?? null,
      input.compteur_affaire_id ?? null,
      "livraison",
      orderType,
      cadreStartForUpdate,
      cadreEndForUpdate,
      destMagasinForUpdate,
      destEmplacementForUpdate,
      input.mode_port_id ?? null,
      input.mode_reglement_id ?? null,
      input.conditions_paiement_id ?? null,
      input.biller_id ?? null,
      input.compte_vente_id ?? null,
      input.commentaire ?? null,
      input.remise_globale ?? 0,
      input.total_ht ?? 0,
      input.total_ttc ?? 0,
    ];

    const updated = await client.query<{ id: string }>(updateSql, updateParams);
    const commandeId = updated.rows[0]?.id;
    if (!commandeId) {
      await client.query("ROLLBACK");
      return null;
    }

    // Safe strategy: replace all lignes + echeances from payload.
    await client.query(`DELETE FROM commande_ligne WHERE commande_id = $1`, [id]);
    await client.query(`DELETE FROM commande_echeance WHERE commande_id = $1`, [id]);
    await insertCommandeLignes(client, id, input.lignes);
    await insertCommandeEcheances(client, id, input.echeances ?? []);
    await insertCommandeDocuments(client, id, documents);

    await client.query("COMMIT");
    return { id: toInt(commandeId, "commande.id") };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function repoDeleteCommande(id: string) {
  const commandeId = toInt(id, "commande_id");
  const before = await pool.query<{ ar_sent_at: string | null }>(
    `SELECT ar_sent_at::text AS ar_sent_at FROM commande_client WHERE id = $1::bigint LIMIT 1`,
    [commandeId]
  );
  const row = before.rows[0] ?? null;
  if (!row) return false;
  if (row.ar_sent_at) {
    throw new HttpError(409, "COMMANDE_LOCKED_AFTER_AR", "Commande is locked after AR has been sent");
  }

  const { rowCount } = await pool.query(`DELETE FROM commande_client WHERE id = $1::bigint`, [commandeId]);
  return (rowCount ?? 0) > 0;
}

export async function repoUpdateCommandeStatus(
  id: string,
  nouveau_statut: string,
  commentaire: string | null,
  userId: number | null
) {
  const commandeId = toInt(id, "commande_id");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (userId === null) {
      throw new HttpError(401, "UNAUTHORIZED", "Authentication required");
    }

    const out = await repoEnsureCommandeWorkflowStatus({
      tx: client,
      commande_id: commandeId,
      nouveau_statut,
      commentaire,
      user_id: userId,
    });

    await client.query("COMMIT");

    for (const notification of out.notifications) {
      emitAppNotificationCreated(notification.user_id, notification);
    }
    if (out.changed) {
      emitEntityChanged({
        entityType: "commande_client",
        entityId: String(commandeId),
        action: "status_changed",
        module: "commandes",
        at: new Date().toISOString(),
        by: { id: userId ?? 0, name: userId ? `User #${userId}` : "System" },
        invalidateKeys: ["commandes:list", `commandes:detail:${commandeId}`],
      });
    }

    return {
      id: out.history_id,
      ancien_statut: out.ancien_statut,
      nouveau_statut: out.nouveau_statut,
      changed: out.changed,
    };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function repoAnalyzeCommandeStock(id: string, audit: AuditContext) {
  const commandeId = toInt(id, "commande_id");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const commandeRes = await client.query<{
      id: number;
      client_id: string | null;
      order_type: string;
      dest_stock_magasin_id: string | null;
      dest_stock_emplacement_id: string | null;
    }>(
      `
        SELECT
          id::bigint::int AS id,
          client_id,
          order_type,
          dest_stock_magasin_id::text AS dest_stock_magasin_id,
          dest_stock_emplacement_id::bigint::text AS dest_stock_emplacement_id
        FROM commande_client
        WHERE id = $1
        FOR UPDATE
      `,
      [commandeId]
    );
    const commande = commandeRes.rows[0] ?? null;
    if (!commande) {
      await client.query("ROLLBACK");
      return null;
    }

    let locationId: string;
    if (commande.order_type === "INTERNE") {
      const magasinId = commande.dest_stock_magasin_id;
      const emplacementIdRaw = commande.dest_stock_emplacement_id;
      const emplacementId = typeof emplacementIdRaw === "string" && /^\d+$/.test(emplacementIdRaw) ? Number(emplacementIdRaw) : null;
      if (!magasinId || typeof emplacementId !== "number" || !Number.isFinite(emplacementId)) {
        throw new HttpError(
          400,
          "DEST_STOCK_LOCATION_REQUIRED",
          "dest_stock_magasin_id and dest_stock_emplacement_id are required for internal orders"
        );
      }
      locationId = await resolveLocationIdForEmplacement(client, {
        magasin_id: magasinId,
        emplacement_id: emplacementId,
        label: "dest_stock_location",
      });
    } else {
      const shipping = await getDefaultShippingLocation(client);
      locationId = shipping.location_id;
    }

    const analysis = await computeCommandeStockAnalysis(client, { commande_id: commandeId, location_id: locationId });

    const hasPartial = analysis.lines.some((l) => l.status === "PARTIAL");
    const hasShortage = analysis.lines.some((l) => l.shortage_qty > 0);

    const needs_confirmation = commande.order_type !== "INTERNE" && hasPartial;
    const suggested_decision: CommandesStockDecisionDTO | null = needs_confirmation ? "SHIP_AVAILABLE_NOW" : null;

    const suggested_scenario =
      commande.order_type === "INTERNE"
        ? "INTERNE_OF"
        : needs_confirmation
          ? "CONFIRMATION_REQUIRED"
          : hasShortage
            ? "LIVRAISON_AND_OF"
            : "LIVRAISON_ONLY";

    await insertCommandeEvent(client, {
      commande_id: commandeId,
      event_type: "STOCK_ANALYZED",
      new_values: {
        location_id: locationId,
        suggested_scenario,
        needs_confirmation,
        suggested_decision,
      },
      user_id: audit.user_id,
    });

    await insertAuditLog(client, audit, {
      action: "commandes.stock.analyze",
      entity_type: "commande_client",
      entity_id: String(commandeId),
      details: {
        commande_id: commandeId,
        location_id: locationId,
        suggested_scenario,
        needs_confirmation,
        suggested_decision,
        lines: analysis.lines,
      },
    });

    await client.query("COMMIT");
    return {
      commande_id: commandeId,
      location_id: locationId,
      lines: analysis.lines,
      suggested_scenario,
      needs_confirmation,
      suggested_decision,
    };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function repoGenerateAffairesFromOrder(id: string, body: GenerateAffairesV3BodyDTO, audit: AuditContext) {
  const commandeId = toInt(id, "commande_id");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const commandeRes = await client.query<{
      client_id: string | null;
      type_affaire: string;
      order_type: string;
      devis_id: string | null;
      numero: string;
      dest_stock_magasin_id: string | null;
      dest_stock_emplacement_id: string | null;
      ar_sent_at: string | null;
    }>(
      `
      SELECT client_id, type_affaire, order_type, devis_id::text AS devis_id, numero,
             dest_stock_magasin_id::text AS dest_stock_magasin_id,
             dest_stock_emplacement_id::bigint::text AS dest_stock_emplacement_id,
             ar_sent_at::text AS ar_sent_at
      FROM commande_client
      WHERE id = $1
      FOR UPDATE
      `,
      [commandeId]
    );
    const commande = commandeRes.rows[0];
    if (!commande) {
      await client.query("ROLLBACK");
      return null;
    }

    const orderType = coerceOrderType(commande.order_type);

    const internalClientId = orderType === "INTERNE" ? await getInternalClientIdSetting(client) : null;
    const clientId = commande.client_id ?? internalClientId;
    if (!clientId) {
      throw new HttpError(
        400,
        orderType === "INTERNE" ? "INTERNAL_CLIENT_REQUIRED" : "COMMANDE_CLIENT_REQUIRED",
        orderType === "INTERNE"
          ? "Internal orders require client_id (or erp_settings 'commandes.internal_client_id')"
          : "Cannot generate affaire from a commande without client_id"
      );
    }

    const requestedLivraisonCountRaw = typeof body.livraison_count === "number" ? body.livraison_count : 1;
    const requestedLivraisonCount = Math.max(1, Math.min(10, Math.trunc(requestedLivraisonCountRaw)));

    // Idempotency + split delivery support: allow multiple LIVRAISON mappings per commande.
    const existingMappings = await listCommandeToAffaireMappings(client, commandeId);
    const existingLivraisons = existingMappings.filter((r) => r.role === "LIVRAISON");

    if (existingMappings.length > 0) {
      if (existingLivraisons.length >= requestedLivraisonCount) {
        const livraison = existingLivraisons[0]?.affaire_id ?? null;
        await client.query("COMMIT");
        return {
          affaire_ids: existingLivraisons.map((r) => r.affaire_id),
          livraison_affaire_id: livraison,
          requires_confirmation: false,
          livraison_affaire_ids: existingLivraisons.map((l) => l.affaire_id),
        };
      }

      // Only create additional livraison affaires. Do not re-run allocations/reservations/OF generation.
      const missing = requestedLivraisonCount - existingLivraisons.length;
      const created: number[] = [];
      for (let i = 0; i < missing; i += 1) {
        const livraisonId = await createAffaire(client, {
          commande_id: commandeId,
          devis_id: commande.devis_id ? toNullableInt(commande.devis_id, "commande.devis_id") : null,
          client_id: clientId,
        });
        await insertCommandeToAffaireMapping(client, {
          commande_id: commandeId,
          affaire_id: livraisonId,
          role: "LIVRAISON",
          commentaire: `Split delivery (${existingLivraisons.length + i + 1}/${requestedLivraisonCount})`,
        });
        created.push(livraisonId);
      }

      const nextMappings = await listCommandeToAffaireMappings(client, commandeId);
      const nextLivraisons = nextMappings.filter((r) => r.role === "LIVRAISON");
      const livraison = nextLivraisons[0]?.affaire_id ?? null;
      await client.query("COMMIT");
      return {
        affaire_ids: nextLivraisons.map((r) => r.affaire_id),
        livraison_affaire_id: livraison,
        requires_confirmation: false,
        livraison_affaire_ids: nextLivraisons.map((l) => l.affaire_id),
        split_created: created,
      };
    }

    if (commande.ar_sent_at) {
      throw new HttpError(409, "COMMANDE_LOCKED_AFTER_AR", "Commande is locked after AR has been sent");
    }

    const refs = await selectCommandeLineRefs(client, commandeId);

    let stockLocationId: string | null = null;
    if (orderType === "INTERNE") {
      const magasinId = commande.dest_stock_magasin_id;
      const emplacementIdRaw = commande.dest_stock_emplacement_id;
      const emplacementId = typeof emplacementIdRaw === "string" && /^\d+$/.test(emplacementIdRaw) ? Number(emplacementIdRaw) : null;
      if (magasinId && typeof emplacementId === "number" && Number.isFinite(emplacementId)) {
        stockLocationId = await resolveLocationIdForEmplacement(client, {
          magasin_id: magasinId,
          emplacement_id: emplacementId,
          label: "dest_stock_location",
        });
      }
    } else {
      try {
        stockLocationId = (await getDefaultShippingLocation(client)).location_id;
      } catch {
        stockLocationId = null;
      }
    }

    let analysis: CommandeStockAnalysis | null = null;
    if (stockLocationId) {
      try {
        analysis = await computeCommandeStockAnalysis(client, { commande_id: commandeId, location_id: stockLocationId });
      } catch {
        analysis = null;
      }
    }
    if (!analysis) {
      analysis = {
        lines: refs.map((r) => {
          const requestedQty = Number(r.qty_ordered);
          const shortage = Math.max(0, requestedQty);
          return {
            commande_ligne_id: r.commande_ligne_id,
            code_piece: r.code_piece,
            article_id: r.article_id,
            article_code: r.article_code,
            article_designation: r.article_designation,
            piece_technique_id: r.piece_technique_id,
            piece_code: r.piece_code,
            piece_designation: r.piece_designation,
            requested_qty: requestedQty,
            available_qty: 0,
            available_used_qty: 0,
            shortage_qty: shortage,
            status: shortage > 0 ? "NONE" : "FULL",
          };
        }),
      };
    }

    const stockAnalysis = analysis;

    const hasPartial = stockAnalysis.lines.some((l) => l.status === "PARTIAL");
    const needsConfirmation = orderType !== "INTERNE" && hasPartial;
    const needsProduction = orderType === "INTERNE" ? true : stockAnalysis.lines.some((l) => l.shortage_qty > 0);

    let decision = body.decision ?? null;
    if (needsConfirmation && decision === null) decision = "SHIP_AVAILABLE_NOW";

    const overrides = new Map<number, number>();
    for (const l of body.lines ?? []) {
      overrides.set(l.commande_ligne_id, Number(l.qty_ship_now));
    }

    const reservedByLine = new Map<number, number>();
    if (decision !== null) {
      for (const l of stockAnalysis.lines) {
        const maxShip = Number(l.available_used_qty);
        const override = overrides.has(l.commande_ligne_id) ? Number(overrides.get(l.commande_ligne_id) ?? 0) : null;
        const qtyToReserve = override === null ? maxShip : override;
        if (!Number.isFinite(qtyToReserve) || qtyToReserve < 0) {
          throw new HttpError(400, "INVALID_QTY", `Invalid qty_ship_now for line ${l.commande_ligne_id}`);
        }
        if (qtyToReserve > maxShip) {
          throw new HttpError(400, "INVALID_QTY", `qty_ship_now for line ${l.commande_ligne_id} exceeds available qty (${maxShip})`);
        }
        reservedByLine.set(l.commande_ligne_id, qtyToReserve);
      }
    }

    const livraisonAffaireIds: number[] = [];
    const livraisonAffaireId = await createAffaire(client, {
      commande_id: commandeId,
      devis_id: commande.devis_id ? toNullableInt(commande.devis_id, "commande.devis_id") : null,
      client_id: clientId,
    });
    await insertCommandeToAffaireMapping(client, {
      commande_id: commandeId,
      affaire_id: livraisonAffaireId,
      role: "LIVRAISON",
      commentaire: "Generated from commande",
    });
    livraisonAffaireIds.push(livraisonAffaireId);

    for (let i = 1; i < requestedLivraisonCount; i += 1) {
      const extraId = await createAffaire(client, {
        commande_id: commandeId,
        devis_id: commande.devis_id ? toNullableInt(commande.devis_id, "commande.devis_id") : null,
        client_id: clientId,
      });
      await insertCommandeToAffaireMapping(client, {
        commande_id: commandeId,
        affaire_id: extraId,
        role: "LIVRAISON",
        commentaire: `Split delivery (${i + 1}/${requestedLivraisonCount})`,
      });
      livraisonAffaireIds.push(extraId);
    }

    const planLines: CommandeAllocationPlanLine[] = analysis.lines.map((l) => ({
      commande_ligne_id: l.commande_ligne_id,
      code_piece: l.code_piece,
      article_ref_id: l.article_id,
      article_legacy_id: null,
      qty_ordered: l.requested_qty,
      qty_on_hand: 0,
      qty_from_stock: l.available_used_qty,
      qty_to_produce: l.shortage_qty,
    }));

    const allocationMode =
      decision !== null
        ? decision
        : needsProduction
          ? "AUTO_OF"
          : "AUTO_STOCK";

    await upsertCommandeAllocations(client, {
      commande_id: commandeId,
      livraison_affaire_id: livraisonAffaireId,
      allocation_mode: allocationMode,
      reserve_stock: false,
      reserved_qty_by_line: decision !== null ? reservedByLine : null,
      lines: planLines,
    });

    const reservationsCreated: string[] = [];
    if (decision !== null && stockLocationId) {
      const reservationItems = stockAnalysis.lines
        .map((l) => {
          const qty = Number(reservedByLine.get(l.commande_ligne_id) ?? 0);
          return { line: l, qty };
        })
        .filter((x) => x.qty > 0);

      reservationItems.sort((a, b) => {
        const aa = a.line.article_id ?? "";
        const bb = b.line.article_id ?? "";
        if (aa !== bb) return aa.localeCompare(bb);
        return a.line.commande_ligne_id - b.line.commande_ligne_id;
      });

      for (const it of reservationItems) {
        const articleId = it.line.article_id;
        if (!articleId) {
          throw new HttpError(400, "ARTICLE_REQUIRED", `Cannot reserve stock for line ${it.line.commande_ligne_id} (missing article_id)`);
        }

        const sl = await client.query<{ id: string; qty_total: number; qty_reserved: number }>(
          `
            SELECT id::text AS id, qty_total::float8 AS qty_total, qty_reserved::float8 AS qty_reserved
            FROM public.stock_levels
            WHERE article_id = $1::uuid
              AND location_id = $2::uuid
            FOR UPDATE
            LIMIT 1
          `,
          [articleId, stockLocationId]
        );
        const row = sl.rows[0] ?? null;
        if (!row) {
          throw new HttpError(409, "INSUFFICIENT_STOCK", `No stock level found for article ${articleId}`);
        }

        const available = Number(row.qty_total) - Number(row.qty_reserved);
        if (available < it.qty - 1e-9) {
          throw new HttpError(409, "INSUFFICIENT_STOCK", `Not enough available stock for article ${articleId} (need ${it.qty}, have ${available})`);
        }

        await client.query(
          `
            UPDATE public.stock_levels
            SET qty_reserved = qty_reserved + $2,
                updated_at = now(),
                updated_by = $3
            WHERE id = $1::uuid
          `,
          [row.id, it.qty, audit.user_id]
        );

        const ins = await client.query<{ id: string }>(
          `
            INSERT INTO public.stock_reservations (
              article_id,
              location_id,
              qty_reserved,
              source_type,
              source_id,
              status,
              created_by,
              updated_by
            ) VALUES ($1::uuid,$2::uuid,$3,'COMMANDE_LIGNE',$4,'ACTIVE',$5,$5)
            RETURNING id::text AS id
          `,
          [articleId, stockLocationId, it.qty, String(it.line.commande_ligne_id), audit.user_id]
        );
        const reservationId = ins.rows[0]?.id ?? null;
        if (reservationId) reservationsCreated.push(reservationId);
      }
    }

    const ofIds: number[] = [];
    if (needsProduction) {
      const byLine = new Map<number, CommandeLineRef>(refs.map((r) => [r.commande_ligne_id, r] as const));

      for (const l of stockAnalysis.lines) {
        const qtyToProduce =
          orderType === "INTERNE" ? l.requested_qty : Number(l.shortage_qty);
        if (!Number.isFinite(qtyToProduce) || qtyToProduce <= 0) continue;

        const ref = byLine.get(l.commande_ligne_id) ?? null;
        const pieceTechniqueId = ref?.piece_technique_id ?? null;
        if (!pieceTechniqueId) {
          throw new HttpError(
            400,
            "PIECE_TECHNIQUE_REQUIRED",
            `Cannot create OF: missing piece_technique_id for line ${l.commande_ligne_id}`
          );
        }

        const idRes = await client.query<{ of_id: string }>(
          `SELECT nextval(pg_get_serial_sequence('public.ordres_fabrication','id'))::text AS of_id`
        );
        const rawId = idRes.rows[0]?.of_id;
        const ofId = toInt(rawId, "ordres_fabrication.id");
        const numero = `OF-${ofId}`;

        await client.query(
          `
            INSERT INTO public.ordres_fabrication (
              id,
              numero,
              affaire_id,
              commande_id,
              commande_ligne_id,
              article_id,
              client_id,
              piece_technique_id,
              quantite_lancee,
              statut,
              priority,
              notes,
              created_by,
              updated_by
            ) VALUES ($1,$2,$3::bigint,$4::bigint,$5::bigint,$6::uuid,$7,$8::uuid,$9,'BROUILLON'::of_status,'NORMAL'::of_priority,$10,$10,$10)
          `,
          [
            ofId,
            numero,
            livraisonAffaireId,
            commandeId,
            l.commande_ligne_id,
            l.article_id,
            clientId,
            pieceTechniqueId,
            qtyToProduce,
            `Generated from commande ${commande.numero} line ${l.commande_ligne_id}`,
            audit.user_id,
          ]
        );

        await client.query(
          `
            INSERT INTO public.of_operations (
              of_id,
              phase,
              designation,
              cf_id,
              poste_id,
              machine_id,
              hourly_rate_applied,
              tp,
              tf_unit,
              qte,
              coef,
              temps_total_planned,
              status,
              notes
            )
            SELECT
              $1::bigint AS of_id,
              pto.phase,
              pto.designation,
              pto.cf_id,
              NULL::uuid AS poste_id,
              NULL::uuid AS machine_id,
              COALESCE(pto.taux_horaire, 0)::numeric(12,2) AS hourly_rate_applied,
              COALESCE(pto.tp, 0)::numeric(12,3) AS tp,
              COALESCE(pto.tf_unit, 0)::numeric(12,3) AS tf_unit,
              COALESCE(pto.qte, 1)::numeric(12,3) AS qte,
              COALESCE(pto.coef, 1)::numeric(10,3) AS coef,
              ROUND((COALESCE(pto.tp,0) + COALESCE(pto.tf_unit,0) * COALESCE(pto.qte,1)) * COALESCE(pto.coef,1), 3)::numeric(12,3) AS temps_total_planned,
              'TODO'::of_operation_status AS status,
              pto.designation_2 AS notes
            FROM public.pieces_techniques_operations pto
            WHERE pto.piece_technique_id = $2::uuid
            ORDER BY pto.phase ASC, pto.id ASC
          `,
          [ofId, pieceTechniqueId]
        );

        ofIds.push(ofId);
      }
    }

    await insertCommandeEvent(client, {
      commande_id: commandeId,
      event_type: "AFFAIRES_GENERATED",
      new_values: {
        order_type: orderType,
        decision,
        stock_location_id: stockLocationId,
        livraison_affaire_ids: livraisonAffaireIds,
        reservations_created: reservationsCreated.length,
        of_created: ofIds.length,
      },
      user_id: audit.user_id,
    });

    await insertAuditLog(client, audit, {
      action: "commandes.affaires.generate",
      entity_type: "commande_client",
      entity_id: String(commandeId),
      details: {
        commande_id: commandeId,
        order_type: orderType,
        decision,
        livraison_affaire_id: livraisonAffaireId,
        livraison_affaire_ids: livraisonAffaireIds,
        reservations_created: reservationsCreated,
        of_ids: ofIds,
      },
    });

    if (reservationsCreated.length > 0) {
      await insertAuditLog(client, audit, {
        action: "stock.reservations.create",
        entity_type: "commande_client",
        entity_id: String(commandeId),
        details: {
          commande_id: commandeId,
          decision,
          stock_location_id: stockLocationId,
          reservation_ids: reservationsCreated,
        },
      });
    }

    await client.query(`UPDATE commande_client SET updated_at = now() WHERE id = $1`, [commandeId]);

    await client.query("COMMIT");

    return {
      affaire_ids: livraisonAffaireIds,
      livraison_affaire_id: livraisonAffaireId,
      requires_confirmation: false,
      livraison_affaire_ids: livraisonAffaireIds,
      reservations_created: reservationsCreated,
      of_ids: ofIds,
    };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

type AffaireCreationInput = {
  commande_id: number;
  client_id: string;
  devis_id?: number | null;
};

async function createAffaire(db: PoolClient, input: AffaireCreationInput): Promise<number> {
  const seq = await db.query<{ id: string }>(`SELECT nextval('public.affaire_id_seq')::bigint::text AS id`);
  const rawId = seq.rows[0]?.id;
  if (!rawId) throw new Error("Failed to allocate affaire id");
  const id = toInt(rawId, "affaire.id");

  const clientCode = await requireClientCode(db, input.client_id);
  const reference = await generateAffaireCode(db, {
    type: "LIV",
    client_code: clientCode,
  });

  const typeAffaire = "livraison";

  await db.query(
    `
    INSERT INTO affaire (id, reference, client_id, commande_id, devis_id, type_affaire)
    VALUES ($1, $2, $3, $4, $5, $6)
    `,
    [id, reference, input.client_id, input.commande_id, input.devis_id ?? null, typeAffaire]
  );
  return id;
}

type MappingInsertInput = {
  commande_id: number;
  affaire_id: number;
  role: "LIVRAISON";
  commentaire: string | null;
};

async function insertCommandeToAffaireMapping(db: PoolClient, input: MappingInsertInput): Promise<void> {
  const hasRoleColumn = await hasCommandeToAffaireRoleColumn(db);
  
  const existing = hasRoleColumn
    ? await db.query<{ id: string }>(
        `
          SELECT id::text AS id
          FROM commande_to_affaire
          WHERE commande_id = $1 AND affaire_id = $2
          LIMIT 1
        `,
        [input.commande_id, input.affaire_id]
      )
    : await db.query<{ id: string }>(
        `
        SELECT id::text AS id
        FROM commande_to_affaire
        WHERE commande_id = $1 AND affaire_id = $2
        LIMIT 1
        `,
        [input.commande_id, input.affaire_id]
      );

  if (existing.rows.length > 0) return;

  if (hasRoleColumn) {
    await db.query(
      `
      INSERT INTO commande_to_affaire (commande_id, affaire_id, commentaire, role)
      VALUES ($1, $2, $3, $4)
      `,
      [input.commande_id, input.affaire_id, input.commentaire, input.role]
    );
    return;
  }

  await db.query(
    `
    INSERT INTO commande_to_affaire (commande_id, affaire_id, commentaire)
    VALUES ($1, $2, $3)
    `,
    [input.commande_id, input.affaire_id, input.commentaire]
  );
}

type CommandeAllocationPlanLine = {
  commande_ligne_id: number;
  code_piece: string | null;
  article_ref_id: string | null;
  article_legacy_id: string | null;
  qty_ordered: number;
  qty_on_hand: number;
  qty_from_stock: number;
  qty_to_produce: number;
};

type CommandeAllocationPlan = {
  lines: CommandeAllocationPlanLine[];
};

type CommandeLineRef = {
  commande_ligne_id: number;
  code_piece: string | null;
  qty_ordered: number;
  article_id: string | null;
  article_code: string | null;
  article_designation: string | null;
  piece_technique_id: string | null;
  piece_code: string | null;
  piece_designation: string | null;
};

async function selectCommandeLineRefs(db: PoolClient, commandeId: number): Promise<CommandeLineRef[]> {
  const res = await db.query<{
    commande_ligne_id: number;
    code_piece: string | null;
    qty_ordered: number;
    article_id: string | null;
    article_code: string | null;
    article_designation: string | null;
    piece_technique_id: string | null;
    piece_code: string | null;
    piece_designation: string | null;
  }>(
    `
      SELECT
        cl.id::bigint::int AS commande_ligne_id,
        COALESCE(a.code, legacy.article_code, cl.code_piece) AS code_piece,
        cl.quantite::float8 AS qty_ordered,
        COALESCE(cl.article_id::text, a.id::text, legacy.article_id) AS article_id,
        COALESCE(a.code, legacy.article_code, cl.code_piece) AS article_code,
        COALESCE(a.designation, legacy.article_designation, cl.designation) AS article_designation,
        COALESCE(cl.piece_technique_id::text, a.piece_technique_id::text, legacy.piece_technique_id) AS piece_technique_id,
        COALESCE(pt.code_piece, legacy.piece_code) AS piece_code,
        COALESCE(pt.designation, legacy.piece_designation) AS piece_designation
      FROM commande_ligne cl
      LEFT JOIN public.articles a ON a.id = cl.article_id
      LEFT JOIN public.pieces_techniques pt ON pt.id = COALESCE(cl.piece_technique_id, a.piece_technique_id)
      LEFT JOIN LATERAL (
        SELECT
          a.id::text AS article_id,
          a.code AS article_code,
          a.designation AS article_designation,
          a.piece_technique_id::text AS piece_technique_id,
          apt.code_piece AS piece_code,
          apt.designation AS piece_designation
        FROM public.articles a
        LEFT JOIN public.pieces_techniques apt
          ON apt.id = a.piece_technique_id
        WHERE cl.article_id IS NULL
          AND cl.code_piece IS NOT NULL
          AND (
            a.code = cl.code_piece
            OR apt.code_piece = cl.code_piece
          )
        ORDER BY (a.code = cl.code_piece) DESC, a.id ASC
        LIMIT 1
      ) legacy ON TRUE
      WHERE cl.commande_id = $1
      ORDER BY cl.id ASC
    `,
    [commandeId]
  );

  return res.rows.map((r) => ({
    commande_ligne_id: r.commande_ligne_id,
    code_piece: r.code_piece,
    qty_ordered: Number(r.qty_ordered),
    article_id: typeof r.article_id === "string" && r.article_id.trim().length > 0 ? r.article_id.trim() : null,
    article_code: typeof r.article_code === "string" && r.article_code.trim().length > 0 ? r.article_code.trim() : null,
    article_designation:
      typeof r.article_designation === "string" && r.article_designation.trim().length > 0
        ? r.article_designation.trim()
        : null,
    piece_technique_id:
      typeof r.piece_technique_id === "string" && r.piece_technique_id.trim().length > 0 ? r.piece_technique_id.trim() : null,
    piece_code: typeof r.piece_code === "string" && r.piece_code.trim().length > 0 ? r.piece_code.trim() : null,
    piece_designation:
      typeof r.piece_designation === "string" && r.piece_designation.trim().length > 0
        ? r.piece_designation.trim()
        : null,
  }));
}

async function loadAvailableQtyByArticle(db: PoolClient, params: {
  article_ids: string[];
  location_id?: string | null;
}): Promise<Map<string, number>> {
  if (params.article_ids.length === 0) return new Map();

  const values: unknown[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  const where: string[] = [`sl.article_id = ANY(${push(params.article_ids)}::uuid[])`];
  if (params.location_id) where.push(`sl.location_id = ${push(params.location_id)}::uuid`);
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const res = await db.query<{ article_id: string; qty_available: number }>(
    `
      SELECT
        sl.article_id::text AS article_id,
        COALESCE(SUM(sl.qty_total - sl.qty_reserved), 0)::float8 AS qty_available
      FROM public.stock_levels sl
      ${whereSql}
      GROUP BY sl.article_id
    `,
    values
  );

  const out = new Map<string, number>();
  for (const r of res.rows) {
    const k = typeof r.article_id === "string" ? r.article_id : "";
    if (!k) continue;
    out.set(k, Number(r.qty_available));
  }
  return out;
}

type StockAvailabilityStatus = "FULL" | "PARTIAL" | "NONE";

type CommandeStockAnalysisLine = {
  commande_ligne_id: number;
  code_piece: string | null;
  article_id: string | null;
  article_code: string | null;
  article_designation: string | null;
  piece_technique_id: string | null;
  piece_code: string | null;
  piece_designation: string | null;
  requested_qty: number;
  available_qty: number;
  available_used_qty: number;
  shortage_qty: number;
  status: StockAvailabilityStatus;
};

type CommandeStockAnalysis = {
  lines: CommandeStockAnalysisLine[];
};

async function computeCommandeStockAnalysis(db: PoolClient, params: {
  commande_id: number;
  location_id: string;
}): Promise<CommandeStockAnalysis> {
  const refs = await selectCommandeLineRefs(db, params.commande_id);
  const articleIds = Array.from(
    new Set(refs.map((r) => r.article_id).filter((v): v is string => typeof v === "string" && v.length > 0))
  );

  const availableByArticle = await loadAvailableQtyByArticle(db, {
    article_ids: articleIds,
    location_id: params.location_id,
  });

  const remainingByArticle = new Map<string, number>();
  const getRemaining = (articleId: string, initial: number) => {
    if (!remainingByArticle.has(articleId)) remainingByArticle.set(articleId, initial);
    return remainingByArticle.get(articleId) ?? 0;
  };

  const lines: CommandeStockAnalysisLine[] = refs.map((r) => {
    const requestedQty = Number(r.qty_ordered);
    const articleId = r.article_id;

    if (!articleId) {
      const shortage = Math.max(0, requestedQty);
      return {
        commande_ligne_id: r.commande_ligne_id,
        code_piece: r.code_piece,
        article_id: null,
        article_code: r.article_code,
        article_designation: r.article_designation,
        piece_technique_id: r.piece_technique_id,
        piece_code: r.piece_code,
        piece_designation: r.piece_designation,
        requested_qty: requestedQty,
        available_qty: 0,
        available_used_qty: 0,
        shortage_qty: shortage,
        status: shortage > 0 ? "NONE" : "FULL",
      };
    }

    const initialAvailable = Number(availableByArticle.get(articleId) ?? 0);
    const remaining = getRemaining(articleId, initialAvailable);
    const used = Math.max(0, Math.min(requestedQty, remaining));
    remainingByArticle.set(articleId, remaining - used);

    const shortage = Math.max(0, requestedQty - used);
    const status: StockAvailabilityStatus = shortage === 0 ? "FULL" : used === 0 ? "NONE" : "PARTIAL";

    return {
      commande_ligne_id: r.commande_ligne_id,
      code_piece: r.code_piece,
      article_id: articleId,
      article_code: r.article_code,
      article_designation: r.article_designation,
      piece_technique_id: r.piece_technique_id,
      piece_code: r.piece_code,
      piece_designation: r.piece_designation,
      requested_qty: requestedQty,
      available_qty: initialAvailable,
      available_used_qty: used,
      shortage_qty: shortage,
      status,
    };
  });

  return { lines };
}

async function computeCommandeAllocationPlan(db: PoolClient, commandeId: number): Promise<CommandeAllocationPlan> {
  const uuidRe =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  function splitArticleId(articleId: string | null): { article_ref_id: string | null; article_legacy_id: string | null } {
    const v = String(articleId ?? "").trim();
    if (!v) return { article_ref_id: null, article_legacy_id: null };
    if (uuidRe.test(v)) return { article_ref_id: v, article_legacy_id: null };
    if (/^\d+$/.test(v)) return { article_ref_id: null, article_legacy_id: v };
    return { article_ref_id: null, article_legacy_id: null };
  }

  const refs = await selectCommandeLineRefs(db, commandeId);
  const articleIds = Array.from(
    new Set(refs.map((r) => r.article_id).filter((v): v is string => typeof v === "string" && v.length > 0))
  );
  const availableByArticle = await loadAvailableQtyByArticle(db, { article_ids: articleIds });

  const remainingByArticle = new Map<string, number>();
  const getRemaining = (articleId: string, initial: number) => {
    if (!remainingByArticle.has(articleId)) remainingByArticle.set(articleId, initial);
    return remainingByArticle.get(articleId) ?? 0;
  };

  const lines: CommandeAllocationPlanLine[] = refs.map((r) => {
    const qtyOrdered = Number(r.qty_ordered);
    const qtyOnHand = r.article_id ? Number(availableByArticle.get(r.article_id) ?? 0) : 0;
    const articleId = r.article_id;
    const { article_ref_id, article_legacy_id } = splitArticleId(articleId);

    let qtyFromStock = 0;
    if (articleId !== null) {
      const remaining = getRemaining(articleId, qtyOnHand);
      qtyFromStock = Math.max(0, Math.min(qtyOrdered, remaining));
      remainingByArticle.set(articleId, remaining - qtyFromStock);
    }

    const qtyToProduce = Math.max(0, qtyOrdered - qtyFromStock);

    return {
      commande_ligne_id: r.commande_ligne_id,
      code_piece: r.code_piece,
      article_ref_id,
      article_legacy_id,
      qty_ordered: qtyOrdered,
      qty_on_hand: qtyOnHand,
      qty_from_stock: qtyFromStock,
      qty_to_produce: qtyToProduce,
    };
  });

  return { lines };
}

type AllocationUpsertInput = {
  commande_id: number;
  livraison_affaire_id: number;
  allocation_mode: string | null;
  reserve_stock: boolean;
  reserved_qty_by_line?: Map<number, number> | null;
  lines: CommandeAllocationPlanLine[];
};

async function upsertCommandeAllocations(db: PoolClient, input: AllocationUpsertInput): Promise<void> {
  for (const l of input.lines) {
    const qtyReserved =
      input.reserved_qty_by_line && input.reserved_qty_by_line.has(l.commande_ligne_id)
        ? Number(input.reserved_qty_by_line.get(l.commande_ligne_id) ?? 0)
        : input.reserve_stock
          ? l.qty_from_stock
          : 0;

    await db.query(
      `
      INSERT INTO public.commande_ligne_affaire_allocation (
        commande_id,
        commande_ligne_id,
        livraison_affaire_id,
        production_affaire_id,
        article_ref_id,
        article_legacy_id,
        qty_ordered,
        qty_from_stock,
        qty_reserved,
        qty_to_produce,
        allocation_mode
      ) VALUES ($1,$2,$3,NULL,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (commande_ligne_id, livraison_affaire_id)
      DO UPDATE SET
        production_affaire_id = NULL,
        article_ref_id = EXCLUDED.article_ref_id,
        article_legacy_id = EXCLUDED.article_legacy_id,
        qty_ordered = EXCLUDED.qty_ordered,
        qty_from_stock = EXCLUDED.qty_from_stock,
        qty_reserved = EXCLUDED.qty_reserved,
        qty_to_produce = EXCLUDED.qty_to_produce,
        allocation_mode = EXCLUDED.allocation_mode,
        updated_at = now()
      `,
      [
        input.commande_id,
        l.commande_ligne_id,
        input.livraison_affaire_id,
        l.article_ref_id,
        l.article_legacy_id,
        l.qty_ordered,
        l.qty_from_stock,
        qtyReserved,
        l.qty_to_produce,
        input.allocation_mode,
      ]
    );
  }
}

export async function repoPreviewAffairesFromCommande(id: string) {
  const commandeId = toInt(id, "commande_id");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const commandeRes = await client.query<{ client_id: string | null }>(
      `
      SELECT client_id
      FROM commande_client
      WHERE id = $1
      `,
      [commandeId]
    );
    const commande = commandeRes.rows[0] ?? null;
    if (!commande) {
      await client.query("ROLLBACK");
      return null;
    }

    if (!commande.client_id) {
      throw new HttpError(400, "COMMANDE_CLIENT_REQUIRED", "Cannot generate affaire from a commande without client_id");
    }

    const existingMappings = await listCommandeToAffaireMappings(client, commandeId);

    if (existingMappings.length > 0) {
      const livraisons = existingMappings.filter((r) => r.role === "LIVRAISON").map((r) => r.affaire_id);
      const livraison = livraisons[0] ?? null;
      await client.query("COMMIT");
      return {
        already_generated: true,
        affaire_ids: livraisons,
        livraison_affaire_id: livraison,
        requires_confirmation: false,
      };
    }

    const plan = await computeCommandeAllocationPlan(client, commandeId);
    const requiresConfirmation = plan.lines.some((l) => l.qty_from_stock > 0 && l.qty_to_produce > 0);

    await client.query("COMMIT");
    return {
      already_generated: false,
      affaire_ids: [],
      livraison_affaire_id: null,
      requires_confirmation: requiresConfirmation,
      plan,
    };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function repoGenerateAffairesFromCommande(id: string, body: GenerateAffairesBodyDTO) {
  const commandeId = toInt(id, "commande_id");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const commandeRes = await client.query<{
      client_id: string | null;
      type_affaire: string;
    }>(
      `
      SELECT client_id, type_affaire
      FROM commande_client
      WHERE id = $1
      FOR UPDATE
      `,
      [commandeId]
    );
    const commande = commandeRes.rows[0] ?? null;
    if (!commande) {
      await client.query("ROLLBACK");
      return null;
    }

    if (!commande.client_id) {
      throw new HttpError(400, "COMMANDE_CLIENT_REQUIRED", "Cannot generate affaire from a commande without client_id");
    }

    // Idempotency: if mappings already exist, return them deterministically.
    const existingMappings = await listCommandeToAffaireMappings(client, commandeId);

    if (existingMappings.length > 0) {
      const livraisons = existingMappings.filter((r) => r.role === "LIVRAISON").map((r) => r.affaire_id);
      const livraison = livraisons[0] ?? null;
      await client.query("COMMIT");
      return {
        affaire_ids: livraisons,
        livraison_affaire_id: livraison,
        requires_confirmation: false,
      };
    }

    const plan = await computeCommandeAllocationPlan(client, commandeId);
    const requiresConfirmation = plan.lines.some((l) => l.qty_from_stock > 0 && l.qty_to_produce > 0);
    const lines = plan.lines;

    if (requiresConfirmation && body.strategy === "AUTO") {
      throw new HttpError(
        409,
        "AFFAIRES_CONFIRMATION_REQUIRED",
        "Partial stock requires an explicit generation strategy"
      );
    }

    // Apply user overrides (only decreasing from the computed missing qty).
    const overrideByLine = new Map<number, number>();
    for (const p of body.production_quantities ?? []) {
      overrideByLine.set(p.commande_ligne_id, Number(p.qty_to_produce));
    }

    const currentByLine = new Map<number, CommandeAllocationPlanLine>(lines.map((l) => [l.commande_ligne_id, l] as const));
    for (const [lineId, requestedQtyToProduce] of overrideByLine.entries()) {
      const current = currentByLine.get(lineId);
      if (!current) {
        throw new HttpError(400, "INVALID_LINE", `Unknown commande_ligne_id: ${lineId}`);
      }
      if (!Number.isFinite(requestedQtyToProduce) || requestedQtyToProduce < 0) {
        throw new HttpError(400, "INVALID_QTY", `Invalid qty_to_produce for line ${lineId}`);
      }
      if (requestedQtyToProduce > current.qty_to_produce) {
        throw new HttpError(
          400,
          "INVALID_QTY",
          `qty_to_produce for line ${lineId} cannot exceed missing quantity (${current.qty_to_produce})`
        );
      }
      current.qty_to_produce = requestedQtyToProduce;
    }

    const needsProduction = lines.some((l) => l.qty_to_produce > 0);

    const livraisonAffaireId = await createAffaire(client, {
      commande_id: commandeId,
      client_id: commande.client_id,
    });

    await insertCommandeToAffaireMapping(client, {
      commande_id: commandeId,
      affaire_id: livraisonAffaireId,
      role: "LIVRAISON",
      commentaire: "Generated from commande",
    });

    const allocationMode = requiresConfirmation ? body.strategy : needsProduction ? "AUTO_OF" : "AUTO_STOCK";
    await upsertCommandeAllocations(client, {
      commande_id: commandeId,
      livraison_affaire_id: livraisonAffaireId,
      allocation_mode: allocationMode,
      reserve_stock: requiresConfirmation && body.strategy === "RESERVE_AND_PRODUCE",
      lines,
    });

    await client.query(`UPDATE commande_client SET updated_at = now() WHERE id = $1`, [commandeId]);

    await client.query("COMMIT");
    return {
      affaire_ids: [livraisonAffaireId],
      livraison_affaire_id: livraisonAffaireId,
      requires_confirmation: false,
    };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function repoConfirmGenerateAffaires(id: string, body: ConfirmGenerateAffairesBodyDTO) {
  const commandeId = toInt(id, "commande_id");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const commandeRes = await client.query<{
      client_id: string | null;
      type_affaire: string;
    }>(
      `
      SELECT client_id, type_affaire
      FROM commande_client
      WHERE id = $1
      FOR UPDATE
      `,
      [commandeId]
    );
    const commande = commandeRes.rows[0] ?? null;
    if (!commande) {
      await client.query("ROLLBACK");
      return null;
    }

    if (!commande.client_id) {
      throw new HttpError(400, "COMMANDE_CLIENT_REQUIRED", "Cannot generate affaire from a commande without client_id");
    }

    const existingMappings = await listCommandeToAffaireMappings(client, commandeId);
    let livraisonAffaireId: number | null =
      existingMappings.find((m) => m.role === "LIVRAISON")?.affaire_id ?? null;

    if (!livraisonAffaireId) {
      livraisonAffaireId = await createAffaire(client, {
        commande_id: commandeId,
        client_id: commande.client_id,
      });
      await insertCommandeToAffaireMapping(client, {
        commande_id: commandeId,
        affaire_id: livraisonAffaireId,
        role: "LIVRAISON",
        commentaire: "Generated from commande",
      });
    }

    const computed = await computeCommandeAllocationPlan(client, commandeId);
    const lines = computed.lines;

    // Apply user overrides (only decreasing from the computed missing qty).
    const overrideByLine = new Map<number, number>();
    for (const p of body.production_quantities ?? []) {
      overrideByLine.set(p.commande_ligne_id, Number(p.qty_to_produce));
    }

    const currentByLine = new Map<number, CommandeAllocationPlanLine>(lines.map((l) => [l.commande_ligne_id, l] as const));
    for (const [lineId, requestedQtyToProduce] of overrideByLine.entries()) {
      const current = currentByLine.get(lineId);
      if (!current) {
        throw new HttpError(400, "INVALID_LINE", `Unknown commande_ligne_id: ${lineId}`);
      }
      if (!Number.isFinite(requestedQtyToProduce) || requestedQtyToProduce < 0) {
        throw new HttpError(400, "INVALID_QTY", `Invalid qty_to_produce for line ${lineId}`);
      }
      if (requestedQtyToProduce > current.qty_to_produce) {
        throw new HttpError(
          400,
          "INVALID_QTY",
          `qty_to_produce for line ${lineId} cannot exceed missing quantity (${current.qty_to_produce})`
        );
      }
      current.qty_to_produce = requestedQtyToProduce;
    }

    await upsertCommandeAllocations(client, {
      commande_id: commandeId,
      livraison_affaire_id: livraisonAffaireId,
      allocation_mode: body.choice,
      reserve_stock: body.choice === "RESERVE_AND_PRODUCE_REST",
      lines,
    });

    await client.query(`UPDATE commande_client SET updated_at = now() WHERE id = $1`, [commandeId]);

    await client.query("COMMIT");
    return {
      affaire_ids: [livraisonAffaireId],
      livraison_affaire_id: livraisonAffaireId,
      requires_confirmation: false,
    };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function repoDuplicateCommande(id: string) {
  const originalCommandeId = toInt(id, "commande_id");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const originalRes = await client.query(
      `
      SELECT
        numero,
        client_id,
        contact_id,
        destinataire_id,
        adresse_facturation_id,
        emetteur,
        code_client,
        compteur_affaire_id,
        type_affaire,
        order_type,
        cadre_start_date,
        cadre_end_date,
        dest_stock_magasin_id,
        dest_stock_emplacement_id,
        mode_port_id,
        mode_reglement_id,
        conditions_paiement_id,
        biller_id,
        compte_vente_id,
        commentaire,
        remise_globale,
        total_ht,
        total_ttc
      FROM commande_client
      WHERE id = $1
      FOR UPDATE
      `,
      [originalCommandeId]
    );
    const original = originalRes.rows[0];
    if (!original) {
      await client.query("ROLLBACK");
      return null;
    }

    const lignesRes = await client.query(
      `
      SELECT
        designation,
        code_piece,
        article_id::text AS article_id,
        piece_technique_id::text AS piece_technique_id,
        quantite,
        unite,
        prix_unitaire_ht,
        remise_ligne,
        taux_tva,
        delai_client,
        delai_interne,
        devis_numero,
        famille
      FROM commande_ligne
      WHERE commande_id = $1
      ORDER BY id ASC
      `,
      [originalCommandeId]
    );

    const seq = await client.query<{ id: string }>(
      `SELECT nextval('public.commande_client_id_seq')::bigint::text AS id`
    );
    const newId = seq.rows[0]?.id;
    if (!newId) throw new Error("Failed to allocate commande id");
    const newIdInt = toInt(newId, "commande_client.id");
    const newNumero = `CC-${newIdInt}`.slice(0, 30);

    await client.query(
      `
      INSERT INTO commande_client (
        id,
        numero,
        client_id,
        contact_id,
        destinataire_id,
        adresse_facturation_id,
        emetteur,
        code_client,
        date_commande,
        arc_edi,
        arc_date_envoi,
        compteur_affaire_id,
        type_affaire,
        order_type,
        cadre_start_date,
        cadre_end_date,
        dest_stock_magasin_id,
        dest_stock_emplacement_id,
        mode_port_id,
        mode_reglement_id,
        conditions_paiement_id,
        biller_id,
        compte_vente_id,
        commentaire,
        remise_globale,
        total_ht,
        total_ttc
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8, CURRENT_DATE, false, NULL, $9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24
      )
      `,
      [
        newIdInt,
        newNumero,
        original.client_id,
        original.contact_id,
        original.destinataire_id,
        original.adresse_facturation_id,
        original.emetteur,
        original.code_client,
        original.compteur_affaire_id,
        "livraison",
        original.order_type,
        original.cadre_start_date,
        original.cadre_end_date,
        original.dest_stock_magasin_id,
        original.dest_stock_emplacement_id,
        original.mode_port_id,
        original.mode_reglement_id,
        original.conditions_paiement_id,
        original.biller_id,
        original.compte_vente_id,
        original.commentaire,
        original.remise_globale,
        original.total_ht,
        original.total_ttc,
      ]
    );

    if (lignesRes.rows.length) {
      const lignesPayload = lignesRes.rows.map((r) => ({
        designation: r.designation as string,
        article_id: (r.article_id as string | null) ?? null,
        code_piece: (r.code_piece as string | null) ?? null,
        quantite: Number(r.quantite),
        unite: (r.unite as string | null) ?? null,
        prix_unitaire_ht: Number(r.prix_unitaire_ht),
        remise_ligne: r.remise_ligne === null ? null : Number(r.remise_ligne),
        taux_tva: r.taux_tva === null ? null : Number(r.taux_tva),
        delai_client: r.delai_client ? String(r.delai_client) : null,
        delai_interne: r.delai_interne ? String(r.delai_interne) : null,
        devis_numero: (r.devis_numero as string | null) ?? null,
        famille: (r.famille as string | null) ?? null,
      }));
      await insertCommandeLignes(client, String(newIdInt), lignesPayload);
    }

    await client.query(
      `
      INSERT INTO commande_historique (commande_id, user_id, ancien_statut, nouveau_statut, commentaire)
      VALUES ($1, $2, $3, $4, $5)
      `,
      [newIdInt, null, null, "ENREGISTREE", `Duplicated from commande ${originalCommandeId}`]
    );

    await client.query("COMMIT");
    return { id: newIdInt };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
