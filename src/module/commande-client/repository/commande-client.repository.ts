import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import type { PoolClient } from "pg";
import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import type {
  CreateCommandeInput,
  UploadedDocument,
  CommandeListItem,
  ClientLite,
} from "../types/commande-client.types";
import type {
  ConfirmGenerateAffairesBodyDTO,
  GenerateAffairesBodyDTO,
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

type CommandeToAffaireRole = "LIVRAISON" | "PRODUCTION" | null;
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
        CASE
          WHEN row_number() OVER (PARTITION BY commande_id ORDER BY id ASC) = 1 THEN 'LIVRAISON'
          WHEN row_number() OVER (PARTITION BY commande_id ORDER BY id ASC) = 2 THEN 'PRODUCTION'
          ELSE NULL
        END AS role
      FROM commande_to_affaire
      WHERE commande_id = $1
      ORDER BY id ASC
      `;

  const res = await db.query<{ affaire_id: number; role: string | null }>(sql, [commandeId]);
  return res.rows.map((r) => ({
    affaire_id: r.affaire_id,
    role: r.role === "LIVRAISON" || r.role === "PRODUCTION" ? r.role : null,
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

type ListWhere = { whereSql: string; values: unknown[] };
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
    where.push(`COALESCE(st.nouveau_statut, 'brouillon') = ${p}`);
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
      COALESCE(st.nouveau_statut, 'brouillon') AS statut,
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
      COALESCE(st.nouveau_statut, 'brouillon') AS statut
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
            id::text AS id,
            commande_id::text AS commande_id,
            designation,
            code_piece,
            quantite::float8 AS quantite,
            unite,
            prix_unitaire_ht::float8 AS prix_unitaire_ht,
            remise_ligne::float8 AS remise_ligne,
            taux_tva::float8 AS taux_tva,
            delai_client::text AS delai_client,
            delai_interne::text AS delai_interne,
            total_ht::float8 AS total_ht,
            total_ttc::float8 AS total_ttc,
            devis_numero,
            famille
          FROM commande_ligne
          WHERE commande_id = $1
          ORDER BY id ASC
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

  const params: unknown[] = [commandeId];
  const valuesSql: string[] = [];

  for (const l of lignes) {
    const baseIndex = params.length;
    params.push(
      l.designation,
      l.code_piece ?? null,
      l.quantite,
      l.unite ?? null,
      l.prix_unitaire_ht,
      l.remise_ligne ?? 0,
      l.taux_tva ?? 20,
      l.delai_client ?? null,
      l.delai_interne ?? null,
      l.devis_numero ?? null,
      l.famille ?? null
    );

    const placeholders = Array.from({ length: 11 }, (_, j) => `$${baseIndex + 1 + j}`).join(",");
    valuesSql.push(`($1,${placeholders})`);
  }

  await client.query(
    `
    INSERT INTO commande_ligne (
      commande_id,
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
    ) VALUES ${valuesSql.join(",")}
    `,
    params
  );
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
      input.type_affaire ?? "fabrication",
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
        dest_stock_emplacement_id::text AS dest_stock_emplacement_id
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
      input.type_affaire ?? "fabrication",
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
  const { rowCount } = await pool.query(`DELETE FROM commande_client WHERE id = $1`, [id]);
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

    const exists = await client.query(`SELECT id::text AS id FROM commande_client WHERE id = $1`, [commandeId]);
    if (exists.rows.length === 0) {
      await client.query("ROLLBACK");
      return null;
    }

    const last = await client.query<{ nouveau_statut: string }>(
      `
      SELECT nouveau_statut
      FROM commande_historique
      WHERE commande_id = $1
      ORDER BY date_action DESC, id DESC
      LIMIT 1
      `,
      [commandeId]
    );
    const ancienStatut = last.rows[0]?.nouveau_statut ?? null;

    const ins = await client.query<{ id: string }>(
      `
      INSERT INTO commande_historique (commande_id, user_id, ancien_statut, nouveau_statut, commentaire)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id::text AS id
      `,
      [commandeId, userId, ancienStatut, nouveau_statut, commentaire]
    );

    await client.query(`UPDATE commande_client SET updated_at = now() WHERE id = $1`, [commandeId]);

    await client.query("COMMIT");
    return {
      id: ins.rows[0]?.id ? toInt(ins.rows[0].id, "commande_historique.id") : null,
      ancien_statut: ancienStatut,
      nouveau_statut,
    };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function repoGenerateAffairesFromOrder(id: string) {
  const commandeId = toInt(id, "commande_id");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const commandeRes = await client.query<{
      client_id: string | null;
      type_affaire: string;
      order_type: string;
    }>(
      `
      SELECT client_id, type_affaire, order_type
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

    if (!commande.client_id) {
      throw new HttpError(400, "COMMANDE_CLIENT_REQUIRED", "Cannot generate affaire from a commande without client_id");
    }

    // Idempotency: if mappings already exist, return them deterministically.
    const existingMappings = await listCommandeToAffaireMappings(client, commandeId);

    if (existingMappings.length > 0) {
      const livraison = existingMappings.find((r) => r.role === "LIVRAISON")?.affaire_id ?? null;
      const production = existingMappings.find((r) => r.role === "PRODUCTION")?.affaire_id ?? null;
      await client.query("COMMIT");
      return {
        affaire_ids: existingMappings.map((r) => r.affaire_id),
        livraison_affaire_id: livraison,
        production_affaire_id: production,
        requires_confirmation: false,
      };
    }

    const livraisonAffaireId = await createAffaire(client, {
      commande_id: commandeId,
      client_id: commande.client_id,
      type_affaire: commande.type_affaire,
    });

    await insertCommandeToAffaireMapping(client, {
      commande_id: commandeId,
      affaire_id: livraisonAffaireId,
      role: "LIVRAISON",
      commentaire: "Generated from commande",
    });

    const plan = await computeCommandeAllocationPlan(client, commandeId);
    const requiresConfirmation = plan.lines.some((l) => l.qty_from_stock > 0 && l.qty_to_produce > 0);
    const needsProduction = plan.lines.some((l) => l.qty_to_produce > 0);

    let productionAffaireId: number | null = null;
    if (!requiresConfirmation && needsProduction) {
      productionAffaireId = await createAffaire(client, {
        commande_id: commandeId,
        client_id: commande.client_id,
        type_affaire: commande.type_affaire,
      });

      await insertCommandeToAffaireMapping(client, {
        commande_id: commandeId,
        affaire_id: productionAffaireId,
        role: "PRODUCTION",
        commentaire: "Auto-generated from commande stock allocation",
      });
    }

    const allocationMode = requiresConfirmation ? "PENDING" : needsProduction ? "AUTO_PRODUCTION" : "AUTO_STOCK";
    await upsertCommandeAllocations(client, {
      commande_id: commandeId,
      livraison_affaire_id: livraisonAffaireId,
      production_affaire_id: productionAffaireId,
      allocation_mode: allocationMode,
      reserve_stock: false,
      lines: plan.lines,
    });

    await client.query(`UPDATE commande_client SET updated_at = now() WHERE id = $1`, [commandeId]);

    await client.query("COMMIT");
    return {
      affaire_ids: [livraisonAffaireId, ...(productionAffaireId ? [productionAffaireId] : [])],
      livraison_affaire_id: livraisonAffaireId,
      production_affaire_id: productionAffaireId,
      requires_confirmation: requiresConfirmation,
      ...(requiresConfirmation ? { plan } : {}),
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
  type_affaire: string;
};

async function createAffaire(db: PoolClient, input: AffaireCreationInput): Promise<number> {
  const seq = await db.query<{ id: string }>(`SELECT nextval('public.affaire_id_seq')::bigint::text AS id`);
  const rawId = seq.rows[0]?.id;
  if (!rawId) throw new Error("Failed to allocate affaire id");
  const id = toInt(rawId, "affaire.id");
  const reference = `AFF-${id}`.slice(0, 30);

  await db.query(
    `
    INSERT INTO affaire (id, reference, client_id, commande_id, type_affaire)
    VALUES ($1, $2, $3, $4, $5)
    `,
    [id, reference, input.client_id, input.commande_id, input.type_affaire]
  );
  return id;
}

type MappingInsertInput = {
  commande_id: number;
  affaire_id: number;
  role: "LIVRAISON" | "PRODUCTION";
  commentaire: string | null;
};

async function insertCommandeToAffaireMapping(db: PoolClient, input: MappingInsertInput): Promise<void> {
  const hasRoleColumn = await hasCommandeToAffaireRoleColumn(db);

  const existing = hasRoleColumn
    ? await db.query<{ id: string }>(
        `
        SELECT id::text AS id
        FROM commande_to_affaire
        WHERE commande_id = $1 AND role = $2
        LIMIT 1
        `,
        [input.commande_id, input.role]
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

  const stockSource = await resolveStockOnHandSource(db);
  const stockJoinSql = stockSource
    ? `LEFT JOIN ${stockSource.table} ${stockSource.alias} ON ${stockSource.alias}.${stockSource.articleIdColumn}::text = art.article_id::text`
    : "";
  const qtyOnHandExpr = stockSource
    ? `COALESCE(SUM(${stockSource.alias}.${stockSource.qtyOnHandColumn}), 0)::float8`
    : `0::float8`;

  const res = await db.query<{
    commande_ligne_id: number;
    code_piece: string | null;
    qty_ordered: number;
    article_id: string | null;
    qty_on_hand: number;
  }>(
    `
    SELECT
      cl.id::bigint::int AS commande_ligne_id,
      cl.code_piece,
      cl.quantite::float8 AS qty_ordered,
      art.article_id::text AS article_id,
      ${qtyOnHandExpr} AS qty_on_hand
    FROM commande_ligne cl
    LEFT JOIN LATERAL (
      SELECT a.id AS article_id
      FROM public.articles a
      LEFT JOIN public.pieces_techniques pt
        ON pt.id = a.piece_technique_id
      WHERE cl.code_piece IS NOT NULL
        AND (
          a.code = cl.code_piece
          OR pt.code_piece = cl.code_piece
        )
      ORDER BY (a.code = cl.code_piece) DESC, a.id ASC
      LIMIT 1
    ) art ON TRUE
    ${stockJoinSql}
    WHERE cl.commande_id = $1
    GROUP BY cl.id, art.article_id
    ORDER BY cl.id ASC
    `,
    [commandeId]
  );

  const remainingByArticle = new Map<string, number>();
  const getRemaining = (articleId: string, initial: number) => {
    if (!remainingByArticle.has(articleId)) remainingByArticle.set(articleId, initial);
    return remainingByArticle.get(articleId) ?? 0;
  };

  const lines: CommandeAllocationPlanLine[] = res.rows.map((r) => {
    const qtyOrdered = Number(r.qty_ordered);
    const qtyOnHand = Number(r.qty_on_hand);
    const articleId = typeof r.article_id === "string" && r.article_id.trim().length > 0 ? r.article_id.trim() : null;
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
  production_affaire_id: number | null;
  allocation_mode: string | null;
  reserve_stock: boolean;
  lines: CommandeAllocationPlanLine[];
};

async function upsertCommandeAllocations(db: PoolClient, input: AllocationUpsertInput): Promise<void> {
  for (const l of input.lines) {
    const qtyReserved = input.reserve_stock ? l.qty_from_stock : 0;

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
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (commande_ligne_id, livraison_affaire_id)
      DO UPDATE SET
        production_affaire_id = EXCLUDED.production_affaire_id,
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
        input.production_affaire_id,
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
      const livraison = existingMappings.find((r) => r.role === "LIVRAISON")?.affaire_id ?? null;
      const production = existingMappings.find((r) => r.role === "PRODUCTION")?.affaire_id ?? null;
      await client.query("COMMIT");
      return {
        already_generated: true,
        affaire_ids: existingMappings.map((r) => r.affaire_id),
        livraison_affaire_id: livraison,
        production_affaire_id: production,
        requires_confirmation: false,
        needs_production: production !== null,
      };
    }

    const plan = await computeCommandeAllocationPlan(client, commandeId);
    const requiresConfirmation = plan.lines.some((l) => l.qty_from_stock > 0 && l.qty_to_produce > 0);
    const needsProduction = plan.lines.some((l) => l.qty_to_produce > 0);

    await client.query("COMMIT");
    return {
      already_generated: false,
      affaire_ids: [],
      livraison_affaire_id: null,
      production_affaire_id: null,
      requires_confirmation: requiresConfirmation,
      needs_production: needsProduction,
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
      const livraison = existingMappings.find((r) => r.role === "LIVRAISON")?.affaire_id ?? null;
      const production = existingMappings.find((r) => r.role === "PRODUCTION")?.affaire_id ?? null;
      await client.query("COMMIT");
      return {
        affaire_ids: existingMappings.map((r) => r.affaire_id),
        livraison_affaire_id: livraison,
        production_affaire_id: production,
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
      type_affaire: commande.type_affaire,
    });

    await insertCommandeToAffaireMapping(client, {
      commande_id: commandeId,
      affaire_id: livraisonAffaireId,
      role: "LIVRAISON",
      commentaire: "Generated from commande",
    });

    let productionAffaireId: number | null = null;
    if (needsProduction) {
      productionAffaireId = await createAffaire(client, {
        commande_id: commandeId,
        client_id: commande.client_id,
        type_affaire: commande.type_affaire,
      });

      await insertCommandeToAffaireMapping(client, {
        commande_id: commandeId,
        affaire_id: productionAffaireId,
        role: "PRODUCTION",
        commentaire: requiresConfirmation
          ? "Generated from commande after arbitration"
          : "Auto-generated from commande stock allocation",
      });
    }

    const allocationMode = requiresConfirmation ? body.strategy : needsProduction ? "AUTO_PRODUCTION" : "AUTO_STOCK";
    await upsertCommandeAllocations(client, {
      commande_id: commandeId,
      livraison_affaire_id: livraisonAffaireId,
      production_affaire_id: productionAffaireId,
      allocation_mode: allocationMode,
      reserve_stock: requiresConfirmation && body.strategy === "RESERVE_AND_PRODUCE",
      lines,
    });

    await client.query(`UPDATE commande_client SET updated_at = now() WHERE id = $1`, [commandeId]);

    await client.query("COMMIT");
    return {
      affaire_ids: [livraisonAffaireId, ...(productionAffaireId ? [productionAffaireId] : [])],
      livraison_affaire_id: livraisonAffaireId,
      production_affaire_id: productionAffaireId,
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
        type_affaire: commande.type_affaire,
      });
      await insertCommandeToAffaireMapping(client, {
        commande_id: commandeId,
        affaire_id: livraisonAffaireId,
        role: "LIVRAISON",
        commentaire: "Generated from commande",
      });
    }

    const existingProductionId = existingMappings.find((m) => m.role === "PRODUCTION")?.affaire_id ?? null;
    if (existingProductionId) {
      await client.query("COMMIT");
      return {
        affaire_ids: [livraisonAffaireId, existingProductionId],
        livraison_affaire_id: livraisonAffaireId,
        production_affaire_id: existingProductionId,
        requires_confirmation: false,
      };
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

    const needsProduction = lines.some((l) => l.qty_to_produce > 0);

    let productionAffaireId: number | null = null;
    if (needsProduction) {
      productionAffaireId = await createAffaire(client, {
        commande_id: commandeId,
        client_id: commande.client_id,
        type_affaire: commande.type_affaire,
      });

      await insertCommandeToAffaireMapping(client, {
        commande_id: commandeId,
        affaire_id: productionAffaireId,
        role: "PRODUCTION",
        commentaire: "Generated after user confirmation (partial stock)",
      });
    }

    await upsertCommandeAllocations(client, {
      commande_id: commandeId,
      livraison_affaire_id: livraisonAffaireId,
      production_affaire_id: productionAffaireId,
      allocation_mode: body.choice,
      reserve_stock: body.choice === "RESERVE_AND_PRODUCE_REST",
      lines,
    });

    await client.query(`UPDATE commande_client SET updated_at = now() WHERE id = $1`, [commandeId]);

    await client.query("COMMIT");
    return {
      affaire_ids: [livraisonAffaireId, ...(productionAffaireId ? [productionAffaireId] : [])],
      livraison_affaire_id: livraisonAffaireId,
      production_affaire_id: productionAffaireId,
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
        original.type_affaire,
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
      [newIdInt, null, null, "brouillon", `Duplicated from commande ${originalCommandeId}`]
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
