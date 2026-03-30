import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import type { PoolClient } from "pg";
import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import type {
  CreateDevisBodyDTO,
  ListDevisQueryDTO,
  UpdateDevisBodyDTO,
} from "../validators/devis.validators";
import type {
  ArticleDevis,
  ClientLite,
  DossierTechniquePieceDevis,
  DevisDocument,
  DevisHeader,
  DevisLine,
  DevisListItem,
  UploadedDocument,
} from "../types/devis.types";
import type { CreateCommandeInput } from "../../commande-client/types/commande-client.types";

type DevisCommandeHeaderRow = {
  id: string;
  numero: string;
  client_id: string;
  contact_id: string | null;
  adresse_facturation_id: string | null;
  adresse_livraison_id: string | null;
  mode_reglement_id: string | null;
  conditions_paiement_id: number | null;
  biller_id: string | null;
  compte_vente_id: string | null;
  commentaires: string | null;
  remise_globale: number;
  total_ht: number;
  total_ttc: number;
  statut: string;
  updated_at: string | null;
  created_at: string | null;
};

type DevisCommandeLineRow = {
  id: string;
  description: string;
  article_id: string | null;
  piece_technique_id: string | null;
  source_article_devis_id: string | null;
  source_dossier_devis_id: string | null;
  code_piece: string | null;
  quantite: number;
  unite: string | null;
  prix_unitaire_ht: number;
  remise_ligne: number | null;
  taux_tva: number | null;
};

type DraftArticleResolution = {
  article_id: string;
  piece_technique_id: string | null;
};

type DraftPreparatoryResolution = {
  source_article_devis_id: string;
  source_dossier_devis_id: string | null;
  article_devis: {
    id: string;
    devis_id: number;
    code: string;
    designation: string;
    primary_category: string;
    article_categories: string[];
    family_code: string;
    plan_index: number;
    projet_id: number | null;
    source_official_article_id: string | null;
  };
  dossier_technique_piece_devis: {
    id: string;
    article_devis_id: string;
    devis_id: number;
    code_piece: string;
    designation: string;
    source_official_piece_technique_id: string | null;
    payload: Record<string, unknown>;
  } | null;
};

type ArticleDevisRow = Omit<ArticleDevis, "devis_id" | "devis_ligne_id" | "version_number" | "plan_index" | "projet_id"> & {
  devis_id: string;
  devis_ligne_id: string | null;
  version_number: number;
  plan_index: number;
  projet_id: number | null;
};

type DossierDevisRow = Omit<DossierTechniquePieceDevis, "devis_id" | "version_number" | "payload"> & {
  devis_id: string;
  version_number: number;
  payload: Record<string, unknown> | null;
};

type DevisLineWithPreparatoryInput = CreateDevisBodyDTO["lignes"][number] & {
  article_devis?: {
    id?: string;
    root_article_devis_id?: string;
    parent_article_devis_id?: string | null;
    version_number?: number;
    code: string;
    designation: string;
    primary_category: string;
    article_categories?: string[];
    family_code: string;
    plan_index?: number;
    projet_id?: number | null;
    source_official_article_id?: string | null;
  };
  dossier_technique_piece_devis?: {
    id?: string;
    root_dossier_devis_id?: string;
    parent_dossier_devis_id?: string | null;
    version_number?: number;
    code_piece: string;
    designation: string;
    source_official_piece_technique_id?: string | null;
    payload?: Record<string, unknown>;
  };
};

export type CommandeDraftFromDevis = {
  devis: {
    id: number;
    numero: string;
    client_id: string;
    updated_at: string | null;
  };
  draft: CreateCommandeInput & {
    devis_id: number;
    source_devis_updated_at: string | null;
  };
};

function toInt(value: unknown, label = "id"): number {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  throw new Error(`Invalid ${label}: ${String(value)}`);
}

function toNullableInt(value: unknown, label = "id"): number | null {
  if (value === null || value === undefined) return null;
  return toInt(value, label);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getPgErrorInfo(err: unknown) {
  if (!isRecord(err)) return { code: null as string | null, constraint: null as string | null };
  const code = typeof err.code === "string" ? err.code : null;
  const constraint = typeof err.constraint === "string" ? err.constraint : null;
  return { code, constraint };
}

function normalizeStatus(value: unknown) {
  if (value === null || value === undefined) return "";
  try {
    return String(value)
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
  } catch {
    return String(value).trim().toLowerCase();
  }
}

function isAcceptedStatus(value: unknown) {
  const s = normalizeStatus(value);
  return s === "accepte" || s === "acceptee";
}

async function loadDevisCommandeHeader(
  client: Pick<PoolClient, "query">,
  devisId: number,
  lockClause = ""
): Promise<DevisCommandeHeaderRow | null> {
  const res = await client.query<DevisCommandeHeaderRow>(
    `
      SELECT
        id::text AS id,
        numero,
        client_id,
        contact_id::text AS contact_id,
        adresse_facturation_id::text AS adresse_facturation_id,
        adresse_livraison_id::text AS adresse_livraison_id,
        mode_reglement_id::text AS mode_reglement_id,
        conditions_paiement_id,
        biller_id::text AS biller_id,
        compte_vente_id::text AS compte_vente_id,
        commentaires,
        remise_globale::float8 AS remise_globale,
        total_ht::float8 AS total_ht,
        total_ttc::float8 AS total_ttc,
        statut,
        updated_at::text AS updated_at,
        created_at::text AS created_at
      FROM devis
      WHERE id = $1
      ${lockClause}
    `,
    [devisId]
  );

  return res.rows[0] ?? null;
}

async function loadDevisCommandeLines(
  client: Pick<PoolClient, "query">,
  devisId: number
): Promise<DevisCommandeLineRow[]> {
  const res = await client.query<DevisCommandeLineRow>(
    `
        SELECT
          id::text AS id,
          description,
          article_id::text AS article_id,
          piece_technique_id::text AS piece_technique_id,
          ad.id::text AS source_article_devis_id,
          dd.id::text AS source_dossier_devis_id,
          code_piece,
          quantite::float8 AS quantite,
          unite,
          prix_unitaire_ht::float8 AS prix_unitaire_ht,
          remise_ligne::float8 AS remise_ligne,
          taux_tva::float8 AS taux_tva
      FROM devis_ligne dl
      LEFT JOIN public.article_devis ad ON ad.devis_ligne_id = dl.id
      LEFT JOIN public.dossier_technique_piece_devis dd ON dd.article_devis_id = ad.id
      WHERE dl.devis_id = $1
      ORDER BY dl.id ASC
    `,
    [devisId]
  );

  return res.rows;
}

async function resolveDraftArticlesByCode(
  client: Pick<PoolClient, "query">,
  lines: DevisCommandeLineRow[]
): Promise<Map<string, DraftArticleResolution>> {
  const codes = Array.from(
    new Set(
      lines
        .map((line) => (typeof line.code_piece === "string" ? line.code_piece.trim() : ""))
        .filter((code) => code.length > 0)
    )
  );

  if (codes.length === 0) return new Map<string, DraftArticleResolution>();

  const res = await client.query<{
    lookup_code: string;
    article_id: string;
    piece_technique_id: string | null;
  }>(
    `
      SELECT DISTINCT ON (lookup.lookup_code)
        lookup.lookup_code,
        a.id::text AS article_id,
        a.piece_technique_id::text AS piece_technique_id
      FROM unnest($1::text[]) AS lookup(lookup_code)
      JOIN public.articles a
        ON a.code = lookup.lookup_code
        OR EXISTS (
          SELECT 1
          FROM public.pieces_techniques pt
          WHERE pt.id = a.piece_technique_id
            AND pt.code_piece = lookup.lookup_code
        )
      WHERE a.is_active = true
        AND a.stock_managed = true
        AND (a.article_category = 'fabrique' OR a.article_category = 'PIECE_TECHNIQUE')
      ORDER BY
        lookup.lookup_code,
        CASE WHEN a.code = lookup.lookup_code THEN 0 ELSE 1 END,
        a.updated_at DESC NULLS LAST,
        a.created_at DESC NULLS LAST,
        a.id ASC
    `,
    [codes]
  );

  const out = new Map<string, DraftArticleResolution>();
  for (const row of res.rows) {
    const key = row.lookup_code.trim();
    if (!key || out.has(key)) continue;
    out.set(key, {
      article_id: row.article_id,
      piece_technique_id: row.piece_technique_id ?? null,
    });
  }
  return out;
}

async function resolveDraftPreparatoryByCode(
  client: Pick<PoolClient, "query">,
  devisId: number,
  lines: DevisCommandeLineRow[]
): Promise<Map<string, DraftPreparatoryResolution>> {
  const codes = Array.from(
    new Set(
      lines
        .map((line) => (typeof line.code_piece === "string" ? line.code_piece.trim() : ""))
        .filter((code) => code.length > 0)
    )
  );
  if (codes.length === 0) return new Map<string, DraftPreparatoryResolution>();

  const res = await client.query<{
    lookup_code: string;
    article_devis_id: string;
    article_devis_devis_id: string;
    article_code: string;
    article_designation: string;
    primary_category: string;
    article_categories: string[];
    family_code: string;
    plan_index: number;
    projet_id: number | null;
    source_official_article_id: string | null;
    dossier_devis_id: string | null;
    dossier_devis_devis_id: string | null;
    dossier_code_piece: string | null;
    dossier_designation: string | null;
    source_official_piece_technique_id: string | null;
    dossier_payload: Record<string, unknown> | null;
  }>(
    `
      SELECT DISTINCT ON (lookup.lookup_code)
        lookup.lookup_code,
        ad.id::text AS article_devis_id,
        ad.devis_id::text AS article_devis_devis_id,
        ad.code AS article_code,
        ad.designation AS article_designation,
        ad.primary_category,
        COALESCE(ad.article_categories, ARRAY[]::text[]) AS article_categories,
        ad.family_code,
        ad.plan_index::int AS plan_index,
        ad.projet_id::int AS projet_id,
        ad.source_official_article_id::text AS source_official_article_id,
        dd.id::text AS dossier_devis_id,
        dd.devis_id::text AS dossier_devis_devis_id,
        dd.code_piece AS dossier_code_piece,
        dd.designation AS dossier_designation,
        dd.source_official_piece_technique_id::text AS source_official_piece_technique_id,
        dd.payload AS dossier_payload
      FROM unnest($1::text[]) AS lookup(lookup_code)
      JOIN public.article_devis ad
        ON ad.code = lookup.lookup_code
      LEFT JOIN public.dossier_technique_piece_devis dd
        ON dd.article_devis_id = ad.id
      ORDER BY
        lookup.lookup_code,
        CASE WHEN ad.devis_id = $2::bigint THEN 0 ELSE 1 END,
        ad.updated_at DESC NULLS LAST,
        ad.created_at DESC NULLS LAST,
        ad.id ASC
    `,
    [codes, devisId]
  );

  const out = new Map<string, DraftPreparatoryResolution>();
  for (const row of res.rows) {
    const key = row.lookup_code.trim();
    if (!key || out.has(key)) continue;
    out.set(key, {
      source_article_devis_id: row.article_devis_id,
      source_dossier_devis_id: row.dossier_devis_id ?? null,
      article_devis: {
        id: row.article_devis_id,
        devis_id: toInt(row.article_devis_devis_id, "article_devis.devis_id"),
        code: row.article_code,
        designation: row.article_designation,
        primary_category: row.primary_category,
        article_categories: row.article_categories ?? [],
        family_code: row.family_code,
        plan_index: row.plan_index,
        projet_id: row.projet_id ?? null,
        source_official_article_id: row.source_official_article_id ?? null,
      },
      dossier_technique_piece_devis: row.dossier_devis_id
        ? {
            id: row.dossier_devis_id,
            article_devis_id: row.article_devis_id,
            devis_id: row.dossier_devis_devis_id ? toInt(row.dossier_devis_devis_id, "dossier_devis.devis_id") : devisId,
            code_piece: row.dossier_code_piece ?? key,
            designation: row.dossier_designation ?? row.article_designation,
            source_official_piece_technique_id: row.source_official_piece_technique_id ?? null,
            payload: row.dossier_payload ?? {},
          }
        : null,
    });
  }
  return out;
}

function buildCommandeDraftFromDevisRows(
  header: DevisCommandeHeaderRow,
  lines: DevisCommandeLineRow[],
  articleByCode: Map<string, DraftArticleResolution>,
  preparatoryByCode: Map<string, DraftPreparatoryResolution>
): CommandeDraftFromDevis {
  const devisId = toInt(header.id, "devis.id");
  const sourceUpdatedAt = header.updated_at ?? header.created_at ?? null;
  return {
    devis: {
      id: devisId,
      numero: header.numero,
      client_id: header.client_id,
      updated_at: sourceUpdatedAt,
    },
    draft: {
      order_type: "FERME",
      client_id: header.client_id,
      contact_id: header.contact_id ?? null,
      destinataire_id: header.adresse_livraison_id ?? null,
      adresse_facturation_id: header.adresse_facturation_id ?? null,
      date_commande: new Date().toISOString().slice(0, 10),
      mode_reglement_id: header.mode_reglement_id ?? null,
      conditions_paiement_id: header.conditions_paiement_id ?? null,
      biller_id: header.biller_id ?? null,
      compte_vente_id: header.compte_vente_id ?? null,
      commentaire: header.commentaires ?? null,
      remise_globale: header.remise_globale ?? 0,
      total_ht: header.total_ht ?? 0,
      total_ttc: header.total_ttc ?? 0,
      devis_id: devisId,
      source_devis_version_id: devisId,
      source_devis_updated_at: sourceUpdatedAt,
      officialize_preparatory_data: false,
      lignes: lines.map((line) => {
        const codePiece = typeof line.code_piece === "string" && line.code_piece.trim().length > 0 ? line.code_piece.trim() : null;
        const resolved = codePiece ? articleByCode.get(codePiece) ?? null : null;
        const preparatory = codePiece ? preparatoryByCode.get(codePiece) ?? null : null;
        return {
          article_id: line.article_id ?? resolved?.article_id ?? null,
          piece_technique_id: line.piece_technique_id ?? resolved?.piece_technique_id ?? null,
          source_article_devis_id: line.source_article_devis_id ?? preparatory?.source_article_devis_id ?? null,
          source_dossier_devis_id: line.source_dossier_devis_id ?? preparatory?.source_dossier_devis_id ?? null,
          designation: line.description,
          code_piece: codePiece,
          quantite: line.quantite,
          unite: line.unite ?? "u",
          prix_unitaire_ht: line.prix_unitaire_ht,
          remise_ligne: line.remise_ligne ?? 0,
          taux_tva: line.taux_tva ?? 20,
          delai_client: null,
          delai_interne: null,
          devis_numero: header.numero,
          famille: null,
          article_devis_data: preparatory?.article_devis ?? null,
          dossier_technique_piece_devis_data: preparatory?.dossier_technique_piece_devis ?? null,
        };
      }),
      echeances: [],
    },
  };
}

function includesSet(includeValue: string) {
  return new Set(
    includeValue
      .split(",")
      .map((x) => x.trim())
      .filter((x) => x.length > 0)
  );
}

function sortColumn(sortBy: ListDevisQueryDTO["sortBy"]) {
  switch (sortBy) {
    case "numero":
      return "d.numero";
    case "date_creation":
      return "d.date_creation";
    case "date_validite":
      return "d.date_validite";
    case "statut":
      return "d.statut";
    case "total_ttc":
      return "d.total_ttc";
    case "total_ht":
      return "d.total_ht";
    case "updated_at":
      return "d.updated_at";
    default:
      return "d.date_creation";
  }
}

function sortDirection(sortDir: ListDevisQueryDTO["sortDir"]) {
  return sortDir === "asc" ? "ASC" : "DESC";
}

type ListWhere = { whereSql: string; values: unknown[] };
function buildListWhere(filters: ListDevisQueryDTO, includeClientInSearch: boolean): ListWhere {
  const where: string[] = [];
  const values: unknown[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  if (filters.q && filters.q.trim().length > 0) {
    const p = push(`%${filters.q.trim()}%`);
    if (includeClientInSearch) {
      where.push(`(d.numero ILIKE ${p} OR c.company_name ILIKE ${p})`);
    } else {
      where.push(`d.numero ILIKE ${p}`);
    }
  }

  if (filters.client_id && filters.client_id.trim().length > 0) {
    const p = push(filters.client_id.trim());
    where.push(`d.client_id = ${p}`);
  }

  if (filters.statut && filters.statut.trim().length > 0) {
    const p = push(filters.statut.trim());
    where.push(`d.statut = ${p}`);
  }

  if (filters.from) {
    const p = push(filters.from);
    where.push(`d.date_creation::date >= ${p}::date`);
  }

  if (filters.to) {
    const p = push(filters.to);
    where.push(`d.date_creation::date <= ${p}::date`);
  }

  return {
    whereSql: where.length ? `WHERE ${where.join(" AND ")}` : "",
    values,
  };
}

export async function repoListDevis(filters: ListDevisQueryDTO) {
  const includes = includesSet(filters.include ?? "client");
  const includeClient = includes.has("client");
  const joinClient = includeClient || (filters.q ? filters.q.trim().length > 0 : false);

  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 20;
  const offset = (page - 1) * pageSize;

  const joinClientSql = joinClient ? "LEFT JOIN clients c ON c.client_id = d.client_id" : "";
  const clientSelectSql = includeClient
    ? `CASE WHEN c.client_id IS NULL THEN NULL ELSE jsonb_build_object(
        'client_id', c.client_id,
        'company_name', c.company_name,
        'email', c.email,
        'phone', c.phone,
        'delivery_address_id', c.delivery_address_id::text,
        'bill_address_id', c.bill_address_id::text
      ) END AS client`
    : "NULL AS client";

  const { whereSql, values } = buildListWhere(filters, joinClient);
  const orderBy = sortColumn(filters.sortBy);
  const orderDir = sortDirection(filters.sortDir);

  const countSql = `
    SELECT COUNT(*)::int AS total
    FROM devis d
    ${joinClientSql}
    ${whereSql}
  `;
  const countRes = await pool.query<{ total: number }>(countSql, values);
  const total = countRes.rows[0]?.total ?? 0;

  const dataSql = `
    SELECT
      d.id::text AS id,
      d.root_devis_id::text AS root_devis_id,
      d.parent_devis_id::text AS parent_devis_id,
      d.version_number::int AS version_number,
      d.numero,
      d.client_id,
      d.date_creation::text AS date_creation,
      d.updated_at::text AS updated_at,
      d.date_validite::text AS date_validite,
      d.statut,
      d.remise_globale::float8 AS remise_globale,
      d.total_ht::float8 AS total_ht,
      d.total_ttc::float8 AS total_ttc,
      ${clientSelectSql}
    FROM devis d
    ${joinClientSql}
    ${whereSql}
    ORDER BY ${orderBy} ${orderDir}
    LIMIT $${values.length + 1}
    OFFSET $${values.length + 2}
  `;

  type DevisListRow = Omit<DevisListItem, "id"> & {
    id: string;
    root_devis_id: string;
    parent_devis_id: string | null;
    client: ClientLite | null;
  };

  const dataRes = await pool.query<DevisListRow>(dataSql, [...values, pageSize, offset]);
  const items = dataRes.rows.map((r) => ({
    ...r,
    id: toInt(r.id, "devis.id"),
    root_devis_id: toInt(r.root_devis_id, "devis.root_devis_id"),
    parent_devis_id: toNullableInt(r.parent_devis_id, "devis.parent_devis_id"),
    client: includeClient ? r.client : undefined,
  }));

  return { items, total };
}

function normalizeArticleCategories(categories: string[] | undefined, primaryCategory: string): string[] {
  const out = new Set<string>();
  const primary = primaryCategory.trim();
  if (primary) out.add(primary);
  for (const c of categories ?? []) {
    const v = c.trim();
    if (v) out.add(v);
  }
  return Array.from(out);
}

type InsertedDevisLine = {
  devis_ligne_id: number;
  input: DevisLineWithPreparatoryInput;
};

async function insertDevisPreparatoryEntities(client: PoolClient, devisId: number, lines: InsertedDevisLine[]) {
  for (const line of lines) {
    const source = line.input;
    if (!source.article_devis) continue;

    const a = source.article_devis;
    const articleDevisId = a.id ?? crypto.randomUUID();
    const rootArticleDevisId = a.root_article_devis_id ?? articleDevisId;
    const articleVersion = a.version_number ?? 1;
    const articleCategories = normalizeArticleCategories(a.article_categories, a.primary_category);

    await client.query(
      `
        INSERT INTO public.article_devis (
          id,
          devis_id,
          devis_ligne_id,
          root_article_devis_id,
          parent_article_devis_id,
          version_number,
          code,
          designation,
          primary_category,
          article_categories,
          family_code,
          plan_index,
          projet_id,
          source_official_article_id
        ) VALUES (
          $1::uuid,$2::bigint,$3::bigint,$4::uuid,$5::uuid,$6::int,$7,$8,$9,$10::text[],$11,$12::int,$13::bigint,$14::uuid
        )
      `,
      [
        articleDevisId,
        devisId,
        line.devis_ligne_id,
        rootArticleDevisId,
        a.parent_article_devis_id ?? null,
        articleVersion,
        a.code.trim(),
        a.designation.trim(),
        a.primary_category.trim(),
        articleCategories,
        a.family_code.trim(),
        a.plan_index ?? 1,
        a.projet_id ?? null,
        a.source_official_article_id ?? source.article_id ?? null,
      ]
    );

    if (!source.dossier_technique_piece_devis) continue;
    const d = source.dossier_technique_piece_devis;
    const dossierDevisId = d.id ?? crypto.randomUUID();
    const rootDossierDevisId = d.root_dossier_devis_id ?? dossierDevisId;
    const dossierVersion = d.version_number ?? 1;

    await client.query(
      `
        INSERT INTO public.dossier_technique_piece_devis (
          id,
          article_devis_id,
          devis_id,
          root_dossier_devis_id,
          parent_dossier_devis_id,
          version_number,
          code_piece,
          designation,
          source_official_piece_technique_id,
          payload
        ) VALUES (
          $1::uuid,$2::uuid,$3::bigint,$4::uuid,$5::uuid,$6::int,$7,$8,$9::uuid,$10::jsonb
        )
      `,
      [
        dossierDevisId,
        articleDevisId,
        devisId,
        rootDossierDevisId,
        d.parent_dossier_devis_id ?? null,
        dossierVersion,
        d.code_piece.trim(),
        d.designation.trim(),
        d.source_official_piece_technique_id ?? source.piece_technique_id ?? null,
        JSON.stringify(d.payload ?? {}),
      ]
    );
  }
}

async function deleteDevisPreparatoryEntities(client: PoolClient, devisId: number) {
  await client.query(`DELETE FROM public.dossier_technique_piece_devis WHERE devis_id = $1::bigint`, [devisId]);
  await client.query(`DELETE FROM public.article_devis WHERE devis_id = $1::bigint`, [devisId]);
}

async function insertDevisLines(client: PoolClient, devisId: number, lignes: CreateDevisBodyDTO["lignes"]) {
  if (!lignes.length) return [] as InsertedDevisLine[];

  const inserted: InsertedDevisLine[] = [];
  for (const line of lignes as DevisLineWithPreparatoryInput[]) {
    const res = await client.query<{ id: string }>(
      `
      INSERT INTO devis_ligne (
        devis_id,
        description,
        article_id,
        piece_technique_id,
        code_piece,
        quantite,
        unite,
        prix_unitaire_ht,
        remise_ligne,
        taux_tva
      ) VALUES ($1,$2,$3::uuid,$4::uuid,$5,$6,$7,$8,$9,$10)
      RETURNING id::text AS id
      `,
      [
        devisId,
        line.description,
        line.article_id ?? null,
        line.piece_technique_id ?? null,
        line.code_piece ?? null,
        line.quantite,
        line.unite ?? null,
        line.prix_unitaire_ht,
        line.remise_ligne ?? 0,
        line.taux_tva ?? 20,
      ]
    );
    const insertedId = res.rows[0]?.id;
    if (!insertedId) throw new Error("Failed to create devis line");
    inserted.push({ devis_ligne_id: toInt(insertedId, "devis_ligne.id"), input: line });
  }

  await insertDevisPreparatoryEntities(client, devisId, inserted);
  return inserted;
}

async function insertDevisDocuments(client: PoolClient, devisId: number, documents: UploadedDocument[]) {
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
      INSERT INTO devis_documents (devis_id, document_id, type)
      VALUES ($1, $2, $3)
      `,
      [devisId, documentId, isPdf ? "PDF" : null]
    );
  }
}

export async function repoGetDevis(id: number, includeValue: string) {
  const includes = includesSet(includeValue);
  const includeClient = includes.has("client");
  const includeLignes = includes.has("lignes");
  const includeDocuments = includes.has("documents");

  const joinClientSql = includeClient ? "LEFT JOIN clients c ON c.client_id = d.client_id" : "";
  const clientSelectSql = includeClient
    ? `CASE WHEN c.client_id IS NULL THEN NULL ELSE jsonb_build_object(
        'client_id', c.client_id,
        'company_name', c.company_name,
        'email', c.email,
        'phone', c.phone,
        'delivery_address_id', c.delivery_address_id::text,
        'bill_address_id', c.bill_address_id::text
      ) END AS client`
    : "NULL AS client";

  const headerSql = `
    SELECT
      d.id::text AS id,
      d.root_devis_id::text AS root_devis_id,
      d.parent_devis_id::text AS parent_devis_id,
      d.version_number::int AS version_number,
      d.numero,
      d.client_id,
      d.contact_id::text AS contact_id,
      d.user_id::text AS user_id,
      d.adresse_facturation_id::text AS adresse_facturation_id,
      d.adresse_livraison_id::text AS adresse_livraison_id,
      d.mode_reglement_id::text AS mode_reglement_id,
      d.compte_vente_id::text AS compte_vente_id,
      d.date_creation::text AS date_creation,
      d.updated_at::text AS updated_at,
      d.date_validite::text AS date_validite,
      d.statut,
      d.remise_globale::float8 AS remise_globale,
      d.total_ht::float8 AS total_ht,
      d.total_ttc::float8 AS total_ttc,
      d.commentaires,
      d.conditions_paiement_id,
      d.biller_id::text AS biller_id,
      ${clientSelectSql}
    FROM devis d
    ${joinClientSql}
    WHERE d.id = $1
  `;

  type HeaderRow = Omit<DevisHeader, "id" | "user_id" | "client"> & {
    id: string;
    root_devis_id: string;
    parent_devis_id: string | null;
    user_id: string;
    client: ClientLite | null;
  };

  const headerRes = await pool.query<HeaderRow>(headerSql, [id]);
  const row = headerRes.rows[0] ?? null;
  if (!row) return null;

  const devis: DevisHeader = {
    ...row,
    id: toInt(row.id, "devis.id"),
    root_devis_id: toInt(row.root_devis_id, "devis.root_devis_id"),
    parent_devis_id: toNullableInt(row.parent_devis_id, "devis.parent_devis_id"),
    user_id: toInt(row.user_id, "devis.user_id"),
    client: includeClient ? row.client : undefined,
  };

  const lignes: DevisLine[] = includeLignes
    ? (
        await pool.query<
          Omit<DevisLine, "id" | "devis_id"> & { id: string; devis_id: string }
        >(
          `
            SELECT
              dl.id::text AS id,
              dl.devis_id::text AS devis_id,
              dl.article_id::text AS article_id,
              dl.piece_technique_id::text AS piece_technique_id,
              ad.id::text AS source_article_devis_id,
              dd.id::text AS source_dossier_devis_id,
              dl.code_piece,
              dl.description,
              dl.quantite::float8 AS quantite,
              dl.unite,
              dl.prix_unitaire_ht::float8 AS prix_unitaire_ht,
              dl.remise_ligne::float8 AS remise_ligne,
              dl.taux_tva::float8 AS taux_tva,
              dl.total_ht::float8 AS total_ht,
              dl.total_ttc::float8 AS total_ttc
            FROM devis_ligne dl
            LEFT JOIN public.article_devis ad ON ad.devis_ligne_id = dl.id
            LEFT JOIN public.dossier_technique_piece_devis dd ON dd.article_devis_id = ad.id
            WHERE dl.devis_id = $1
            ORDER BY dl.id ASC
            `,
           [id]
         )
       ).rows.map((l) => ({
          ...l,
          id: toInt(l.id, "devis_ligne.id"),
          devis_id: toInt(l.devis_id, "devis_ligne.devis_id"),
        }))
      : [];

  const articleDevisRows = includeLignes ? await loadArticleDevisByDevis(pool, id) : [];
  const dossierDevisRows = includeLignes ? await loadDossierDevisByDevis(pool, id) : [];

  const articleById = new Map<string, ArticleDevis>();
  for (const a of articleDevisRows) {
    articleById.set(a.id, a);
  }
  const dossierById = new Map<string, DossierTechniquePieceDevis>();
  for (const d of dossierDevisRows) {
    dossierById.set(d.id, d);
  }
  const dossierByArticleId = new Map<string, DossierTechniquePieceDevis>();
  for (const d of dossierDevisRows) {
    if (!dossierByArticleId.has(d.article_devis_id)) {
      dossierByArticleId.set(d.article_devis_id, d);
    }
  }

  const lignesWithPreparatory = lignes.map((l) => {
    const explicitArticle = typeof l.source_article_devis_id === "string" ? articleById.get(l.source_article_devis_id) ?? null : null;
    const implicitArticle = explicitArticle ?? (articleDevisRows.find((a) => a.devis_ligne_id === l.id) ?? null);

    const explicitDossier = typeof l.source_dossier_devis_id === "string" ? dossierById.get(l.source_dossier_devis_id) ?? null : null;
    const implicitDossier = explicitDossier ?? (implicitArticle ? dossierByArticleId.get(implicitArticle.id) ?? null : null);

    return {
      ...l,
      source_article_devis_id: explicitArticle?.id ?? implicitArticle?.id ?? null,
      source_dossier_devis_id: explicitDossier?.id ?? implicitDossier?.id ?? null,
      article_devis: implicitArticle,
      dossier_technique_piece_devis: implicitDossier,
    };
  });

  const documents: DevisDocument[] = includeDocuments
    ? (
        await pool.query<
          Omit<DevisDocument, "id" | "devis_id"> & { id: string; devis_id: string }
        >(
          `
          SELECT
            dd.id::text AS id,
            dd.devis_id::text AS devis_id,
            dd.document_id::text AS document_id,
            dd.type,
            CASE WHEN dc.id IS NULL THEN NULL ELSE jsonb_build_object(
              'id', dc.id::text,
              'document_name', dc.document_name,
              'type', dc.type,
              'creation_date', dc.creation_date::text,
              'created_by', dc.created_by
            ) END AS document
          FROM devis_documents dd
          LEFT JOIN documents_clients dc ON dc.id = dd.document_id
          WHERE dd.devis_id = $1
          ORDER BY dd.id DESC
          `,
          [id]
        )
      ).rows.map((d) => ({
        ...d,
        id: toInt(d.id, "devis_documents.id"),
        devis_id: toInt(d.devis_id, "devis_documents.devis_id"),
      }))
    : [];

  return { devis, lignes: lignesWithPreparatory, documents };
}

export type DevisDocumentFileMeta = {
  id: string;
  document_name: string;
  type: string | null;
};

async function loadArticleDevisByDevis(client: Pick<PoolClient, "query">, devisId: number) {
  const res = await client.query<ArticleDevisRow>(
    `
      SELECT
        ad.id::text AS id,
        ad.devis_id::text AS devis_id,
        ad.devis_ligne_id::text AS devis_ligne_id,
        ad.root_article_devis_id::text AS root_article_devis_id,
        ad.parent_article_devis_id::text AS parent_article_devis_id,
        ad.version_number::int AS version_number,
        ad.code,
        ad.designation,
        ad.primary_category,
        COALESCE(ad.article_categories, ARRAY[]::text[]) AS article_categories,
        ad.family_code,
        ad.plan_index::int AS plan_index,
        ad.projet_id::int AS projet_id,
        ad.source_official_article_id::text AS source_official_article_id,
        ad.created_at::text AS created_at,
        ad.updated_at::text AS updated_at
      FROM public.article_devis ad
      WHERE ad.devis_id = $1::bigint
      ORDER BY ad.created_at ASC, ad.id ASC
    `,
    [devisId]
  );

  return res.rows.map((r) => ({
    ...r,
    devis_id: toInt(r.devis_id, "article_devis.devis_id"),
    devis_ligne_id: toNullableInt(r.devis_ligne_id, "article_devis.devis_ligne_id"),
    version_number: toInt(r.version_number, "article_devis.version_number"),
    plan_index: toInt(r.plan_index, "article_devis.plan_index"),
    projet_id: r.projet_id === null ? null : toInt(r.projet_id, "article_devis.projet_id"),
  }));
}

async function loadDossierDevisByDevis(client: Pick<PoolClient, "query">, devisId: number) {
  const res = await client.query<DossierDevisRow>(
    `
      SELECT
        dd.id::text AS id,
        dd.article_devis_id::text AS article_devis_id,
        dd.devis_id::text AS devis_id,
        dd.root_dossier_devis_id::text AS root_dossier_devis_id,
        dd.parent_dossier_devis_id::text AS parent_dossier_devis_id,
        dd.version_number::int AS version_number,
        dd.code_piece,
        dd.designation,
        dd.source_official_piece_technique_id::text AS source_official_piece_technique_id,
        dd.payload,
        dd.created_at::text AS created_at,
        dd.updated_at::text AS updated_at
      FROM public.dossier_technique_piece_devis dd
      WHERE dd.devis_id = $1::bigint
      ORDER BY dd.created_at ASC, dd.id ASC
    `,
    [devisId]
  );

  return res.rows.map((r) => ({
    ...r,
    devis_id: toInt(r.devis_id, "dossier_devis.devis_id"),
    version_number: toInt(r.version_number, "dossier_devis.version_number"),
    payload: r.payload ?? {},
  }));
}

async function cloneDevisPreparatoryEntities(client: PoolClient, sourceDevisId: number, targetDevisId: number) {
  const sourceArticles = await client.query<{
    id: string;
    devis_ligne_id: string | null;
    root_article_devis_id: string;
    code: string;
    designation: string;
    primary_category: string;
    article_categories: string[];
    family_code: string;
    plan_index: number;
    projet_id: number | null;
    source_official_article_id: string | null;
  }>(
    `
      SELECT
        id::text AS id,
        devis_ligne_id::text AS devis_ligne_id,
        root_article_devis_id::text AS root_article_devis_id,
        code,
        designation,
        primary_category,
        COALESCE(article_categories, ARRAY[]::text[]) AS article_categories,
        family_code,
        plan_index::int AS plan_index,
        projet_id::int AS projet_id,
        source_official_article_id::text AS source_official_article_id
      FROM public.article_devis
      WHERE devis_id = $1::bigint
      ORDER BY created_at ASC, id ASC
    `,
    [sourceDevisId]
  );

  if (sourceArticles.rows.length === 0) return;

  const lineMapRes = await client.query<{ source_line_id: string; target_line_id: string }>(
    `
      WITH src AS (
        SELECT id, row_number() OVER (ORDER BY id ASC) AS rn
        FROM public.devis_ligne
        WHERE devis_id = $1::bigint
      ), tgt AS (
        SELECT id, row_number() OVER (ORDER BY id ASC) AS rn
        FROM public.devis_ligne
        WHERE devis_id = $2::bigint
      )
      SELECT src.id::text AS source_line_id, tgt.id::text AS target_line_id
      FROM src
      JOIN tgt ON tgt.rn = src.rn
    `,
    [sourceDevisId, targetDevisId]
  );
  const targetLineBySourceLine = new Map<string, number>();
  for (const row of lineMapRes.rows) {
    targetLineBySourceLine.set(row.source_line_id, toInt(row.target_line_id, "devis_ligne.id"));
  }

  const sourceIds = sourceArticles.rows.map((r) => r.id);
  const maxVersionRes = await client.query<{ root_id: string; max_version: number }>(
    `
      SELECT root_article_devis_id::text AS root_id, COALESCE(MAX(version_number), 0)::int AS max_version
      FROM public.article_devis
      WHERE root_article_devis_id = ANY($1::uuid[])
      GROUP BY root_article_devis_id
    `,
    [sourceIds]
  );
  const maxVersionByRoot = new Map<string, number>(maxVersionRes.rows.map((r) => [r.root_id, r.max_version]));

  const newArticleByOldArticle = new Map<string, string>();
  for (const article of sourceArticles.rows) {
    const newId = crypto.randomUUID();
    const nextVersion = (maxVersionByRoot.get(article.root_article_devis_id) ?? 0) + 1;
    maxVersionByRoot.set(article.root_article_devis_id, nextVersion);

    const sourceLineId = article.devis_ligne_id ? toInt(article.devis_ligne_id, "devis_ligne.id") : null;
    const mappedTargetLineId = sourceLineId ? targetLineBySourceLine.get(String(sourceLineId)) ?? null : null;

    await client.query(
      `
        INSERT INTO public.article_devis (
          id,
          devis_id,
          devis_ligne_id,
          root_article_devis_id,
          parent_article_devis_id,
          version_number,
          code,
          designation,
          primary_category,
          article_categories,
          family_code,
          plan_index,
          projet_id,
          source_official_article_id
        ) VALUES (
          $1::uuid,$2::bigint,$3::bigint,$4::uuid,$5::uuid,$6::int,$7,$8,$9,$10::text[],$11,$12::int,$13::bigint,$14::uuid
        )
      `,
      [
        newId,
        targetDevisId,
        mappedTargetLineId,
        article.root_article_devis_id,
        article.id,
        nextVersion,
        article.code,
        article.designation,
        article.primary_category,
        article.article_categories,
        article.family_code,
        article.plan_index,
        article.projet_id,
        article.source_official_article_id,
      ]
    );
    newArticleByOldArticle.set(article.id, newId);
  }

  const sourceDossiers = await client.query<{
    id: string;
    article_devis_id: string;
    root_dossier_devis_id: string;
    code_piece: string;
    designation: string;
    source_official_piece_technique_id: string | null;
    payload: Record<string, unknown> | null;
  }>(
    `
      SELECT
        id::text AS id,
        article_devis_id::text AS article_devis_id,
        root_dossier_devis_id::text AS root_dossier_devis_id,
        code_piece,
        designation,
        source_official_piece_technique_id::text AS source_official_piece_technique_id,
        payload
      FROM public.dossier_technique_piece_devis
      WHERE devis_id = $1::bigint
      ORDER BY created_at ASC, id ASC
    `,
    [sourceDevisId]
  );

  if (sourceDossiers.rows.length === 0) return;

  const dossierRoots = Array.from(new Set(sourceDossiers.rows.map((r) => r.root_dossier_devis_id)));
  const dossierVersionRes = await client.query<{ root_id: string; max_version: number }>(
    `
      SELECT root_dossier_devis_id::text AS root_id, COALESCE(MAX(version_number), 0)::int AS max_version
      FROM public.dossier_technique_piece_devis
      WHERE root_dossier_devis_id = ANY($1::uuid[])
      GROUP BY root_dossier_devis_id
    `,
    [dossierRoots]
  );
  const dossierMaxByRoot = new Map<string, number>(dossierVersionRes.rows.map((r) => [r.root_id, r.max_version]));

  for (const dossier of sourceDossiers.rows) {
    const mappedArticleDevisId = newArticleByOldArticle.get(dossier.article_devis_id);
    if (!mappedArticleDevisId) continue;
    const newDossierId = crypto.randomUUID();
    const nextVersion = (dossierMaxByRoot.get(dossier.root_dossier_devis_id) ?? 0) + 1;
    dossierMaxByRoot.set(dossier.root_dossier_devis_id, nextVersion);

    await client.query(
      `
        INSERT INTO public.dossier_technique_piece_devis (
          id,
          article_devis_id,
          devis_id,
          root_dossier_devis_id,
          parent_dossier_devis_id,
          version_number,
          code_piece,
          designation,
          source_official_piece_technique_id,
          payload
        ) VALUES (
          $1::uuid,$2::uuid,$3::bigint,$4::uuid,$5::uuid,$6::int,$7,$8,$9::uuid,$10::jsonb
        )
      `,
      [
        newDossierId,
        mappedArticleDevisId,
        targetDevisId,
        dossier.root_dossier_devis_id,
        dossier.id,
        nextVersion,
        dossier.code_piece,
        dossier.designation,
        dossier.source_official_piece_technique_id,
        JSON.stringify(dossier.payload ?? {}),
      ]
    );
  }
}

export async function repoGetDevisDocumentFileMeta(devisId: number, docId: string): Promise<DevisDocumentFileMeta | null> {
  const sql = `
    SELECT
      dc.id::text AS id,
      dc.document_name,
      dc.type
    FROM devis_documents dd
    JOIN documents_clients dc ON dc.id = dd.document_id
    WHERE dd.devis_id = $1
      AND dd.document_id = $2
    LIMIT 1
  `;

  const res = await pool.query<DevisDocumentFileMeta>(sql, [devisId, docId]);
  return res.rows[0] ?? null;
}

export async function repoCreateDevis(input: CreateDevisBodyDTO, userId: number, documents: UploadedDocument[]) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const seq = await client.query<{ id: string }>(`SELECT nextval('public.devis_id_seq')::bigint::text AS id`);
    const idRaw = seq.rows[0]?.id;
    if (!idRaw) throw new Error("Failed to allocate devis id");
    const devisId = toInt(idRaw, "devis.id");

    const numero = (input.numero ?? `DV-${devisId}`).slice(0, 30);
    const dateCreation = (input.date_creation ?? new Date().toISOString().slice(0, 10)).slice(0, 10);

    const ins = await client.query<{ id: string }>(
      `
      INSERT INTO devis (
        id,
        root_devis_id,
        parent_devis_id,
        version_number,
        numero,
        client_id,
        contact_id,
        user_id,
        adresse_facturation_id,
        adresse_livraison_id,
        mode_reglement_id,
        compte_vente_id,
        date_creation,
        date_validite,
        statut,
        remise_globale,
        total_ht,
        total_ttc,
        commentaires,
        conditions_paiement_id,
        biller_id
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::date,$14::date,$15,$16,$17,$18,$19,$20,$21
      )
      RETURNING id::text AS id
      `,
      [
        devisId,
        devisId,
        null,
        1,
        numero,
        input.client_id,
        input.contact_id ?? null,
        userId,
        input.adresse_facturation_id ?? null,
        input.adresse_livraison_id ?? null,
        input.mode_reglement_id ?? null,
        input.compte_vente_id ?? null,
        dateCreation,
        input.date_validite ?? null,
        input.statut,
        input.remise_globale,
        input.total_ht,
        input.total_ttc,
        input.commentaires ?? null,
        input.conditions_paiement_id ?? null,
        input.biller_id ?? null,
      ]
    );

    await insertDevisLines(client, devisId, input.lignes);
    await insertDevisDocuments(client, devisId, documents);

    await client.query("COMMIT");

    const inserted = ins.rows[0]?.id;
    return { id: inserted ? toInt(inserted, "devis.id") : devisId };
  } catch (err) {
    await client.query("ROLLBACK");
    const { code, constraint } = getPgErrorInfo(err);
    if (code === "23505" && constraint === "devis_numero_key") {
      throw new HttpError(409, "DEVIS_NUMERO_EXISTS", "Numero already exists");
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function repoUpdateDevis(
  id: number,
  input: UpdateDevisBodyDTO,
  userId: number,
  documents: UploadedDocument[]
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const sets: string[] = [];
    const values: unknown[] = [id];
    const push = (v: unknown) => {
      values.push(v);
      return `$${values.length}`;
    };

    if (input.numero !== undefined) sets.push(`numero = ${push(input.numero)}`);
    if (input.client_id !== undefined) sets.push(`client_id = ${push(input.client_id)}`);
    if (input.contact_id !== undefined) sets.push(`contact_id = ${push(input.contact_id)}::uuid`);

    // keep user_id stable unless explicitly provided
    if (input.user_id !== undefined) sets.push(`user_id = ${push(input.user_id)}::bigint`);

    if (input.adresse_facturation_id !== undefined)
      sets.push(`adresse_facturation_id = ${push(input.adresse_facturation_id)}::uuid`);
    if (input.adresse_livraison_id !== undefined)
      sets.push(`adresse_livraison_id = ${push(input.adresse_livraison_id)}::uuid`);
    if (input.mode_reglement_id !== undefined) sets.push(`mode_reglement_id = ${push(input.mode_reglement_id)}::uuid`);
    if (input.compte_vente_id !== undefined) sets.push(`compte_vente_id = ${push(input.compte_vente_id)}::uuid`);
    if (input.date_creation !== undefined && input.date_creation !== null)
      sets.push(`date_creation = ${push(input.date_creation)}::date`);
    if (input.date_validite !== undefined) sets.push(`date_validite = ${push(input.date_validite)}::date`);
    if (input.statut !== undefined) sets.push(`statut = ${push(input.statut)}`);
    if (input.remise_globale !== undefined) sets.push(`remise_globale = ${push(input.remise_globale)}`);
    if (input.total_ht !== undefined) sets.push(`total_ht = ${push(input.total_ht)}`);
    if (input.total_ttc !== undefined) sets.push(`total_ttc = ${push(input.total_ttc)}`);
    if (input.commentaires !== undefined) sets.push(`commentaires = ${push(input.commentaires)}`);
    if (input.conditions_paiement_id !== undefined)
      sets.push(`conditions_paiement_id = ${push(input.conditions_paiement_id)}::int`);
    if (input.biller_id !== undefined) sets.push(`biller_id = ${push(input.biller_id)}::uuid`);

    if (sets.length === 0 && input.lignes === undefined && documents.length === 0) {
      await client.query("ROLLBACK");
      throw new HttpError(400, "NO_UPDATE", "No fields to update");
    }

    let updatedId: number | null = null;
    if (sets.length) {
      sets.push("updated_at = now()");
      const updateSql = `
        UPDATE devis
        SET ${sets.join(", ")}
        WHERE id = $1
        RETURNING id::text AS id
      `;
      const updateRes = await client.query<{ id: string }>(updateSql, values);
      const row = updateRes.rows[0] ?? null;
      if (!row) {
        await client.query("ROLLBACK");
        return null;
      }
      updatedId = toInt(row.id, "devis.id");
    } else {
      const touch = await client.query<{ id: string }>(
        `UPDATE devis SET updated_at = now() WHERE id = $1 RETURNING id::text AS id`,
        [id]
      );
      const row = touch.rows[0] ?? null;
      if (!row) {
        await client.query("ROLLBACK");
        return null;
      }
      updatedId = toInt(row.id, "devis.id");
    }

    if (input.lignes) {
      await deleteDevisPreparatoryEntities(client, id);
      await client.query(`DELETE FROM devis_ligne WHERE devis_id = $1`, [id]);
      await insertDevisLines(client, id, input.lignes);
    }

    await insertDevisDocuments(client, id, documents);

    await client.query("COMMIT");
    return { id: updatedId };
  } catch (err) {
    await client.query("ROLLBACK");
    const { code, constraint } = getPgErrorInfo(err);
    if (code === "23505" && constraint === "devis_numero_key") {
      throw new HttpError(409, "DEVIS_NUMERO_EXISTS", "Numero already exists");
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function repoReviseDevis(
  id: number,
  input: UpdateDevisBodyDTO,
  userId: number,
  documents: UploadedDocument[]
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const sourceRes = await client.query<{
      id: string;
      root_devis_id: string | null;
      numero: string;
      client_id: string;
      contact_id: string | null;
      adresse_facturation_id: string | null;
      adresse_livraison_id: string | null;
      mode_reglement_id: string | null;
      compte_vente_id: string | null;
      date_validite: string | null;
      statut: string;
      remise_globale: number;
      total_ht: number;
      total_ttc: number;
      commentaires: string | null;
      conditions_paiement_id: number | null;
      biller_id: string | null;
    }>(
      `
        SELECT
          id::text AS id,
          root_devis_id::text AS root_devis_id,
          numero,
          client_id,
          contact_id::text AS contact_id,
          adresse_facturation_id::text AS adresse_facturation_id,
          adresse_livraison_id::text AS adresse_livraison_id,
          mode_reglement_id::text AS mode_reglement_id,
          compte_vente_id::text AS compte_vente_id,
          date_validite::text AS date_validite,
          statut,
          remise_globale::float8 AS remise_globale,
          total_ht::float8 AS total_ht,
          total_ttc::float8 AS total_ttc,
          commentaires,
          conditions_paiement_id,
          biller_id::text AS biller_id
        FROM devis
        WHERE id = $1
        FOR UPDATE
      `,
      [id]
    );

    const source = sourceRes.rows[0] ?? null;
    if (!source) {
      await client.query("ROLLBACK");
      return null;
    }

    const rootDevisId = source.root_devis_id ? toInt(source.root_devis_id, "devis.root_devis_id") : toInt(source.id, "devis.id");
    const versionRes = await client.query<{ next_version: number }>(
      `
        SELECT COALESCE(MAX(version_number), 0)::int + 1 AS next_version
        FROM devis
        WHERE root_devis_id = $1
      `,
      [rootDevisId]
    );
    const nextVersion = versionRes.rows[0]?.next_version ?? 1;

    const idRes = await client.query<{ id: string }>(`SELECT nextval('public.devis_id_seq')::bigint::text AS id`);
    const rawId = idRes.rows[0]?.id;
    if (!rawId) throw new Error("Failed to allocate devis id");
    const newDevisId = toInt(rawId, "devis.id");

    const computedNumero = `${source.numero}-V${nextVersion}`.slice(0, 30);
    const numero = (input.numero ?? computedNumero).slice(0, 30);
    const dateCreation = (input.date_creation ?? new Date().toISOString().slice(0, 10)).slice(0, 10);

    const inserted = await client.query<{ id: string }>(
      `
        INSERT INTO devis (
          id,
          root_devis_id,
          parent_devis_id,
          version_number,
          numero,
          client_id,
          contact_id,
          user_id,
          adresse_facturation_id,
          adresse_livraison_id,
          mode_reglement_id,
          compte_vente_id,
          date_creation,
          date_validite,
          statut,
          remise_globale,
          total_ht,
          total_ttc,
          commentaires,
          conditions_paiement_id,
          biller_id
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::date,$14::date,$15,$16,$17,$18,$19,$20,$21
        )
        RETURNING id::text AS id
      `,
      [
        newDevisId,
        rootDevisId,
        id,
        nextVersion,
        numero,
        input.client_id ?? source.client_id,
        input.contact_id !== undefined ? input.contact_id : source.contact_id,
        input.user_id ?? userId,
        input.adresse_facturation_id !== undefined ? input.adresse_facturation_id : source.adresse_facturation_id,
        input.adresse_livraison_id !== undefined ? input.adresse_livraison_id : source.adresse_livraison_id,
        input.mode_reglement_id !== undefined ? input.mode_reglement_id : source.mode_reglement_id,
        input.compte_vente_id !== undefined ? input.compte_vente_id : source.compte_vente_id,
        dateCreation,
        input.date_validite !== undefined ? input.date_validite : source.date_validite,
        input.statut ?? source.statut,
        input.remise_globale ?? source.remise_globale,
        input.total_ht ?? source.total_ht,
        input.total_ttc ?? source.total_ttc,
        input.commentaires !== undefined ? input.commentaires : source.commentaires,
        input.conditions_paiement_id !== undefined ? input.conditions_paiement_id : source.conditions_paiement_id,
        input.biller_id !== undefined ? input.biller_id : source.biller_id,
      ]
    );

    if (input.lignes) {
      await insertDevisLines(client, newDevisId, input.lignes);
    } else {
      await client.query(
        `
          INSERT INTO devis_ligne (
            devis_id,
            description,
            article_id,
            piece_technique_id,
            code_piece,
            quantite,
            unite,
            prix_unitaire_ht,
            remise_ligne,
            taux_tva
          )
          SELECT
            $1,
            description,
            article_id,
            piece_technique_id,
            code_piece,
            quantite,
            unite,
            prix_unitaire_ht,
            remise_ligne,
            taux_tva
          FROM devis_ligne
          WHERE devis_id = $2
          ORDER BY id ASC
        `,
        [newDevisId, id]
      );

      await cloneDevisPreparatoryEntities(client, id, newDevisId);
    }

    await client.query(
      `
        INSERT INTO devis_documents (devis_id, document_id, type)
        SELECT $1, document_id, type
        FROM devis_documents
        WHERE devis_id = $2
      `,
      [newDevisId, id]
    );

    await insertDevisDocuments(client, newDevisId, documents);

    await client.query("COMMIT");
    const newId = inserted.rows[0]?.id;
    return {
      id: newId ? toInt(newId, "devis.id") : newDevisId,
      root_devis_id: rootDevisId,
      parent_devis_id: id,
      version_number: nextVersion,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    const { code, constraint } = getPgErrorInfo(err);
    if (code === "23505" && constraint === "devis_numero_key") {
      throw new HttpError(409, "DEVIS_NUMERO_EXISTS", "Numero already exists");
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function repoFindDevisByArticle(articleId: string, limit: number) {
  const res = await pool.query<
    Omit<DevisListItem, "id" | "root_devis_id" | "parent_devis_id"> & {
      id: string;
      root_devis_id: string;
      parent_devis_id: string | null;
      client: ClientLite | null;
    }
  >(
    `
      SELECT DISTINCT
        d.id::text AS id,
        d.root_devis_id::text AS root_devis_id,
        d.parent_devis_id::text AS parent_devis_id,
        d.version_number::int AS version_number,
        d.numero,
        d.client_id,
        d.date_creation::text AS date_creation,
        d.updated_at::text AS updated_at,
        d.date_validite::text AS date_validite,
        d.statut,
        d.remise_globale::float8 AS remise_globale,
        d.total_ht::float8 AS total_ht,
        d.total_ttc::float8 AS total_ttc,
        CASE WHEN c.client_id IS NULL THEN NULL ELSE jsonb_build_object(
          'client_id', c.client_id,
          'company_name', c.company_name,
          'email', c.email,
          'phone', c.phone,
          'delivery_address_id', c.delivery_address_id::text,
          'bill_address_id', c.bill_address_id::text
        ) END AS client
      FROM public.devis_ligne dl
      JOIN public.devis d ON d.id = dl.devis_id
      LEFT JOIN public.clients c ON c.client_id = d.client_id
      LEFT JOIN public.articles a ON a.id = $1::uuid
      WHERE dl.article_id = $1::uuid
         OR (a.piece_technique_id IS NOT NULL AND dl.piece_technique_id = a.piece_technique_id)
      ORDER BY d.updated_at DESC NULLS LAST, d.date_creation DESC, d.id DESC
      LIMIT $2
    `,
    [articleId, limit]
  );

  return {
    items: res.rows.map((r) => ({
      ...r,
      id: toInt(r.id, "devis.id"),
      root_devis_id: toInt(r.root_devis_id, "devis.root_devis_id"),
      parent_devis_id: toNullableInt(r.parent_devis_id, "devis.parent_devis_id"),
    })),
    total: res.rows.length,
  };
}

export async function repoFindDevisByArticleDevisCode(code: string, limit: number) {
  const normalizedCode = code.trim();
  const res = await pool.query<
    Omit<DevisListItem, "id" | "root_devis_id" | "parent_devis_id"> & {
      id: string;
      root_devis_id: string;
      parent_devis_id: string | null;
      client: ClientLite | null;
    }
  >(
    `
      SELECT DISTINCT
        d.id::text AS id,
        d.root_devis_id::text AS root_devis_id,
        d.parent_devis_id::text AS parent_devis_id,
        d.version_number::int AS version_number,
        d.numero,
        d.client_id,
        d.date_creation::text AS date_creation,
        d.updated_at::text AS updated_at,
        d.date_validite::text AS date_validite,
        d.statut,
        d.remise_globale::float8 AS remise_globale,
        d.total_ht::float8 AS total_ht,
        d.total_ttc::float8 AS total_ttc,
        CASE WHEN c.client_id IS NULL THEN NULL ELSE jsonb_build_object(
          'client_id', c.client_id,
          'company_name', c.company_name,
          'email', c.email,
          'phone', c.phone,
          'delivery_address_id', c.delivery_address_id::text,
          'bill_address_id', c.bill_address_id::text
        ) END AS client
      FROM public.article_devis ad
      JOIN public.devis d ON d.id = ad.devis_id
      LEFT JOIN public.clients c ON c.client_id = d.client_id
      WHERE ad.code = $1
      ORDER BY d.updated_at DESC NULLS LAST, d.date_creation DESC, d.id DESC
      LIMIT $2
    `,
    [normalizedCode, limit]
  );

  return {
    items: res.rows.map((r) => ({
      ...r,
      id: toInt(r.id, "devis.id"),
      root_devis_id: toInt(r.root_devis_id, "devis.root_devis_id"),
      parent_devis_id: toNullableInt(r.parent_devis_id, "devis.parent_devis_id"),
    })),
    total: res.rows.length,
  };
}

export async function repoGetCommandeDraftFromDevis(devisId: number): Promise<CommandeDraftFromDevis | null> {
  const client = await pool.connect();
  try {
    const devis = await loadDevisCommandeHeader(client, devisId);
    if (!devis) return null;

    if (!isAcceptedStatus(devis.statut)) {
      throw new HttpError(400, "DEVIS_NOT_ACCEPTED", "Devis must be accepted before preparing a commande");
    }

    const lines = await loadDevisCommandeLines(client, devisId);
    if (lines.length === 0) {
      throw new HttpError(400, "DEVIS_EMPTY", "Devis has no lines to prepare");
    }

    const articleByCode = await resolveDraftArticlesByCode(client, lines);
    const preparatoryByCode = await resolveDraftPreparatoryByCode(client, devisId, lines);
    return buildCommandeDraftFromDevisRows(devis, lines, articleByCode, preparatoryByCode);
  } finally {
    client.release();
  }
}

export async function repoConvertDevisToCommande(devisId: number) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const devis = await loadDevisCommandeHeader(client, devisId, "FOR UPDATE");
    if (!devis) {
      await client.query("ROLLBACK");
      return null;
    }

    if (!isAcceptedStatus(devis.statut)) {
      throw new HttpError(400, "DEVIS_NOT_ACCEPTED", "Devis must be accepted before conversion");
    }

    const existing = await client.query<{ id: string; numero: string }>(
      `
      SELECT id::text AS id, numero
      FROM commande_client
      WHERE devis_id = $1
      LIMIT 1
      `,
      [devisId]
    );
    if (existing.rows.length > 0) {
      const numero = existing.rows[0]?.numero;
      throw new HttpError(409, "DEVIS_ALREADY_CONVERTED", numero ? `Devis already converted (${numero})` : "Devis already converted");
    }

    const seq = await client.query<{ id: string }>(
      `SELECT nextval('public.commande_client_id_seq')::bigint::text AS id`
    );
    const idRaw = seq.rows[0]?.id;
    if (!idRaw) throw new Error("Failed to allocate commande id");
    const commandeId = toInt(idRaw, "commande_client.id");
    const commandeNumero = `CC-${commandeId}`.slice(0, 30);

    await client.query(
      `
      INSERT INTO commande_client (
        id,
        numero,
        client_id,
        contact_id,
        destinataire_id,
        mode_reglement_id,
        conditions_paiement_id,
        biller_id,
        compte_vente_id,
        commentaire,
        type_affaire,
        remise_globale,
        total_ht,
        total_ttc,
        devis_id,
        source_devis_version_id
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16
      )
      `,
      [
        commandeId,
        commandeNumero,
        devis.client_id,
        devis.contact_id ?? null,
        devis.adresse_livraison_id ?? null,
        devis.mode_reglement_id ?? null,
        devis.conditions_paiement_id ?? null,
        devis.biller_id ?? null,
        devis.compte_vente_id ?? null,
        devis.commentaires ?? null,
        "livraison",
        devis.remise_globale ?? 0,
        devis.total_ht ?? 0,
        devis.total_ttc ?? 0,
        devisId,
        devisId,
      ]
    );

    const insLines = await client.query(
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
        famille,
        source_article_devis_id,
        source_dossier_devis_id
      )
      SELECT
        $1,
        dl.article_id,
        dl.piece_technique_id,
        dl.description,
        dl.code_piece,
        dl.quantite,
        dl.unite,
        dl.prix_unitaire_ht,
        dl.remise_ligne,
        dl.taux_tva,
        NULL,
        NULL,
        $2,
        NULL,
        ad.id,
        dd.id
      FROM devis_ligne dl
      LEFT JOIN public.article_devis ad ON ad.devis_ligne_id = dl.id
      LEFT JOIN public.dossier_technique_piece_devis dd ON dd.article_devis_id = ad.id
      WHERE dl.devis_id = $3
      ORDER BY dl.id ASC
      `,
      [commandeId, devis.numero, devisId]
    );

    if ((insLines.rowCount ?? 0) === 0) {
      throw new HttpError(400, "DEVIS_EMPTY", "Devis has no lines to convert");
    }

    await client.query(
      `
        UPDATE public.articles a
        SET status = 'VALIDE',
            updated_at = now()
        WHERE a.status = 'EN_DEVIS'
          AND a.id IN (
            SELECT DISTINCT cl.article_id
            FROM public.commande_ligne cl
            WHERE cl.commande_id = $1
              AND cl.article_id IS NOT NULL
          )
      `,
      [commandeId]
    );

    await client.query("COMMIT");
    return { id: commandeId, numero: commandeNumero };
  } catch (err) {
    await client.query("ROLLBACK");
    const { code, constraint } = getPgErrorInfo(err);
    if (code === "23505" && constraint === "commande_client_devis_id_key") {
      throw new HttpError(409, "DEVIS_ALREADY_CONVERTED", "Devis already converted");
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function repoDeleteDevis(id: number) {
  const { rowCount } = await pool.query(`DELETE FROM devis WHERE id = $1`, [id]);
  return (rowCount ?? 0) > 0;
}
