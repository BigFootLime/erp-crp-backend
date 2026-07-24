import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import type { PoolClient } from "pg";
import pool from "../../../config/database";
import { ensureDocumentStoragePath } from "../../../utils/cerpStorage";
import { HttpError } from "../../../utils/httpError";
import { generateCommandeCode, generateDevisCode } from "../../../shared/codes/code-generator.service";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import type { CreateAuditLogBodyDTO } from "../../audit-logs/validators/audit-logs.validators";
import { computeDevisTotals, computeLineTotals } from "../lib/totals";
import {
  DEVIS_STATUT_TRANSITIONS,
  canTransitionDevisStatut,
  normalizeDevisStatut,
  type DevisStatut,
} from "../lib/status";
import { capabilityForDevisTransition, roleHasDevisCapability } from "../domain/devis-rbac";
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
import { repoCreateCommande } from "../../commande-client/repository/commande-client.repository";

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

/* ----------------------- #167 : audit, idempotence, fraîcheur ----------------------- */

export type AuditContext = {
  user_id: number;
  role?: string | null;
  ip: string | null;
  user_agent: string | null;
  device_type: string | null;
  os: string | null;
  browser: string | null;
  path: string | null;
  page_key: string | null;
  client_session_id: string | null;
};

/** Contexte d'écriture optionnel — absent = comportement historique (compatible). */
export type DevisWriteContext = {
  idempotency_key?: string;
  audit?: AuditContext;
};

type DbQueryer = Pick<PoolClient, "query">;

async function insertDevisAuditLog(
  tx: DbQueryer,
  audit: AuditContext | undefined,
  entry: {
    action: string;
    entity_id: string | null;
    details?: Record<string, unknown> | null;
  }
) {
  if (!audit) return;
  const body: CreateAuditLogBodyDTO = {
    event_type: "ACTION",
    action: entry.action,
    page_key: audit.page_key,
    entity_type: "devis",
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

/** Sérialisation stable (clés triées) — miroir du pattern #172, local pour éviter un couplage inter-modules. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(",")}}`;
}

function sha256Hex(payload: string): string {
  return crypto.createHash("sha256").update(payload, "utf8").digest("hex");
}

export function devisIdempotencyPayloadHash(payload: unknown): string {
  return sha256Hex(stableStringify(payload));
}

type DevisIdempotenceAction = "CREATE" | "REVISE" | "CONVERT";

/**
 * Rejeu idempotent (#167) : même clé + même payload -> même résultat (200) ;
 * même clé + action différente -> 409 IDEMPOTENCY_KEY_REUSED ;
 * même clé + payload différent -> 409 IDEMPOTENCY_PAYLOAD_MISMATCH.
 */
async function readDevisIdempotentReplay(
  tx: DbQueryer,
  key: string,
  action: DevisIdempotenceAction,
  payloadHash: string
): Promise<Record<string, unknown> | null> {
  const res = await tx.query<{ action: string; payload_hash: string; resultat: Record<string, unknown> }>(
    `SELECT action, payload_hash, resultat FROM public.devis_idempotence WHERE cle = $1`,
    [key]
  );
  const row = res.rows[0];
  if (!row) return null;
  if (row.action !== action) {
    throw new HttpError(409, "IDEMPOTENCY_KEY_REUSED", "Cette clé d'idempotence a déjà servi à une autre action.");
  }
  if (row.payload_hash !== payloadHash) {
    throw new HttpError(
      409,
      "IDEMPOTENCY_PAYLOAD_MISMATCH",
      "Cette clé d'idempotence a déjà servi avec un contenu différent."
    );
  }
  return { ...row.resultat, idempotent_replay: true };
}

async function recordDevisIdempotence(
  tx: DbQueryer,
  key: string,
  action: DevisIdempotenceAction,
  devisId: number | null,
  payloadHash: string,
  resultat: Record<string, unknown>
) {
  await tx.query(
    `INSERT INTO public.devis_idempotence (cle, action, devis_id, payload_hash, resultat)
     VALUES ($1,$2,$3,$4,$5::jsonb)`,
    [key, action, devisId, payloadHash, JSON.stringify(resultat)]
  );
}

/**
 * Conversion delegates commande creation to its own transaction. The immutable
 * commande_client.devis_id uniqueness constraint already elects one winner, so
 * recording the replay result happens afterwards. A concurrent identical recorder
 * may therefore win first; validate that row instead of turning a safe replay into
 * an error. Reusing the key for another action or payload still raises 409.
 */
async function recordConvertedDevisIdempotence(
  tx: DbQueryer,
  key: string,
  devisId: number,
  payloadHash: string,
  resultat: Record<string, unknown>
) {
  const inserted = await tx.query<{ cle: string }>(
    `INSERT INTO public.devis_idempotence (cle, action, devis_id, payload_hash, resultat)
     VALUES ($1,'CONVERT',$2,$3,$4::jsonb)
     ON CONFLICT (cle) DO NOTHING
     RETURNING cle`,
    [key, devisId, payloadHash, JSON.stringify(resultat)]
  );
  if (inserted.rows[0]) return;

  // On real PostgreSQL, no returned row means a concurrent key already exists.
  // Lightweight SQL dispatchers used by route tests may not return RETURNING rows;
  // an absent replay there is harmless because they cannot model the race.
  await readDevisIdempotentReplay(tx, key, "CONVERT", payloadHash);
}

/** La table d'idempotence arrive par patch 20260722 : absence tolérée (comportement historique). */
async function hasDevisIdempotenceTable(client: DbQueryer): Promise<boolean> {
  const res = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'devis_idempotence'
     ) AS exists`
  );
  return res.rows[0]?.exists === true;
}

function timestampsMatch(expected: string, current: string | null): boolean {
  if (current === null) return false;
  if (expected === current) return true;
  const expectedMs = Date.parse(expected);
  const currentMs = Date.parse(current);
  return Number.isFinite(expectedMs) && Number.isFinite(currentMs) && expectedMs === currentMs;
}

/**
 * Verrou optimiste (#167) : le jeton `expected_updated_at` fourni par le client doit
 * correspondre au `updated_at` courant (comparaison tolérante aux formats texte/JSONB).
 * Divergence -> 409, jamais d'écrasement silencieux.
 */
function assertDevisFresh(
  expected: string | null | undefined,
  current: string | null,
  code: "DEVIS_STALE" | "DEVIS_DRAFT_STALE" = "DEVIS_STALE"
) {
  if (!expected) return;
  if (!timestampsMatch(expected, current)) {
    throw new HttpError(
      409,
      code,
      "Le devis a été modifié entre-temps. Rechargez-le pour repartir de la version courante.",
      { current_updated_at: current }
    );
  }
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

async function devisLineCodePieceSelect(client: Pick<PoolClient, "query">) {
  const legacyColumnExpr = (await hasPublicColumn(client, "devis_ligne", "code_piece"))
    ? "NULLIF(dl.code_piece, '')"
    : "NULL::text";

  return `COALESCE(${legacyColumnExpr}, dd.code_piece, ad.code, a.code, pt.code_piece) AS code_piece`;
}

async function loadDevisCommandeHeader(
  client: Pick<PoolClient, "query">,
  devisId: number,
  lockClause = ""
): Promise<DevisCommandeHeaderRow | null> {
  const res = await client.query<DevisCommandeHeaderRow>(
    `
      SELECT
        d.id::text AS id,
        d.numero,
        d.client_id,
        d.contact_id::text AS contact_id,
        d.adresse_facturation_id::text AS adresse_facturation_id,
        d.adresse_livraison_id::text AS adresse_livraison_id,
        d.mode_reglement_id::text AS mode_reglement_id,
        d.conditions_paiement_id,
        d.biller_id::text AS biller_id,
        d.compte_vente_id::text AS compte_vente_id,
        d.commentaires,
        d.remise_globale::float8 AS remise_globale,
        d.total_ht::float8 AS total_ht,
        d.total_ttc::float8 AS total_ttc,
        d.statut,
        to_jsonb(d)->>'updated_at' AS updated_at,
        COALESCE(to_jsonb(d)->>'created_at', d.date_creation::text) AS created_at
      FROM devis d
      WHERE d.id = $1
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
  const codePieceSelect = await devisLineCodePieceSelect(client);
  const res = await client.query<DevisCommandeLineRow>(
    `
        SELECT
          dl.id::text AS id,
          dl.description,
          dl.article_id::text AS article_id,
          dl.piece_technique_id::text AS piece_technique_id,
          ad.id::text AS source_article_devis_id,
          dd.id::text AS source_dossier_devis_id,
          ${codePieceSelect},
          dl.quantite::float8 AS quantite,
          dl.unite,
          dl.prix_unitaire_ht::float8 AS prix_unitaire_ht,
          dl.remise_ligne::float8 AS remise_ligne,
          dl.taux_tva::float8 AS taux_tva
      FROM devis_ligne dl
      LEFT JOIN public.article_devis ad ON ad.devis_ligne_id = dl.id
      LEFT JOIN public.dossier_technique_piece_devis dd ON dd.article_devis_id = ad.id
      LEFT JOIN public.articles a ON a.id = dl.article_id
      LEFT JOIN public.pieces_techniques pt ON pt.id = COALESCE(dl.piece_technique_id, a.piece_technique_id, dd.source_official_piece_technique_id)
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
      WHERE COALESCE((to_jsonb(a)->>'is_active')::boolean, true) = true
        AND COALESCE((to_jsonb(a)->>'stock_managed')::boolean, true) = true
        AND COALESCE(
          to_jsonb(a)->>'article_category',
          CASE WHEN a.article_type = 'PIECE_TECHNIQUE' THEN 'fabrique' ELSE NULL END
        ) IN ('fabrique', 'PIECE_TECHNIQUE')
      ORDER BY
        lookup.lookup_code,
        CASE WHEN a.code = lookup.lookup_code THEN 0 ELSE 1 END,
        ((to_jsonb(a)->>'updated_at')::timestamptz) DESC NULLS LAST,
        ((to_jsonb(a)->>'created_at')::timestamptz) DESC NULLS LAST,
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
        ((to_jsonb(ad)->>'updated_at')::timestamptz) DESC NULLS LAST,
        ((to_jsonb(ad)->>'created_at')::timestamptz) DESC NULLS LAST,
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

async function hasPublicColumn(client: Pick<PoolClient, "query">, tableName: string, columnName: string) {
  const res = await client.query<{ exists: boolean }>(
    `
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = $1
          AND column_name = $2
      ) AS exists
    `,
    [tableName, columnName]
  );
  return res.rows[0]?.exists === true;
}

async function insertDevisLines(client: PoolClient, devisId: number, lignes: CreateDevisBodyDTO["lignes"]) {
  if (!lignes.length) return [] as InsertedDevisLine[];

  const hasCodePieceColumn = await hasPublicColumn(client, "devis_ligne", "code_piece");
  // #167 : la position est persistée (ordre du payload = ordre métier) et les totaux de
  // ligne sont recalculés serveur. Colonnes gardées (patch 20260722 / schéma legacy).
  const hasPositionColumn = await hasPublicColumn(client, "devis_ligne", "position");
  const hasLineTotalsColumns =
    (await hasPublicColumn(client, "devis_ligne", "total_ht")) &&
    (await hasPublicColumn(client, "devis_ligne", "total_ttc"));
  const inserted: InsertedDevisLine[] = [];
  let position = 0;
  for (const line of lignes as DevisLineWithPreparatoryInput[]) {
    position += 1;
    const lineTotals = computeLineTotals(line);
    const columns = [
      "devis_id",
      "description",
      "article_id",
      "piece_technique_id",
      ...(hasCodePieceColumn ? ["code_piece"] : []),
      "quantite",
      "unite",
      "prix_unitaire_ht",
      "remise_ligne",
      "taux_tva",
      ...(hasPositionColumn ? ["position"] : []),
      ...(hasLineTotalsColumns ? ["total_ht", "total_ttc"] : []),
    ];
    const values = [
      devisId,
      line.description,
      line.article_id ?? null,
      line.piece_technique_id ?? null,
      ...(hasCodePieceColumn ? [line.code_piece ?? null] : []),
      line.quantite,
      line.unite ?? null,
      line.prix_unitaire_ht,
      line.remise_ligne ?? 0,
      line.taux_tva ?? 20,
      ...(hasPositionColumn ? [position] : []),
      ...(hasLineTotalsColumns ? [lineTotals.total_ht, lineTotals.total_ttc] : []),
    ];
    const placeholders = values.map((_, idx) => {
      const index = idx + 1;
      const column = columns[idx];
      if (column === "article_id" || column === "piece_technique_id") return `$${index}::uuid`;
      return `$${index}`;
    });

    const res = await client.query<{ id: string }>(
      `
      INSERT INTO devis_ligne (${columns.join(", ")})
      VALUES (${placeholders.join(", ")})
      RETURNING id::text AS id
      `,
      values
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
    const uploadDir = ensureDocumentStoragePath();
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

  const codePieceSelect = includeLignes ? await devisLineCodePieceSelect(pool) : "NULL::text AS code_piece";
  const hasLinePositionColumn = includeLignes ? await hasPublicColumn(pool, "devis_ligne", "position") : false;
  const positionSelect = hasLinePositionColumn ? "dl.position::int AS position" : "NULL::int AS position";
  const lignesOrderClause = hasLinePositionColumn ? "dl.position ASC NULLS LAST, dl.id ASC" : "dl.id ASC";
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
              ${codePieceSelect},
              ${positionSelect},
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
            LEFT JOIN public.articles a ON a.id = dl.article_id
            LEFT JOIN public.pieces_techniques pt ON pt.id = COALESCE(dl.piece_technique_id, a.piece_technique_id, dd.source_official_piece_technique_id)
            WHERE dl.devis_id = $1
            ORDER BY ${lignesOrderClause}
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

  // #167 : l'UI reflète l'automate et les liens serveur — elle ne les décide jamais.
  const statutCourant = normalizeDevisStatut(devis.statut);
  const flagsRes = await pool.query<{ has_children: boolean; commande_id: string | null; commande_numero: string | null }>(
    `
      SELECT
        EXISTS (SELECT 1 FROM devis child WHERE child.parent_devis_id = d.id) AS has_children,
        cc.id::text AS commande_id,
        cc.numero AS commande_numero
      FROM devis d
      LEFT JOIN commande_client cc ON cc.devis_id = d.id
      WHERE d.id = $1
    `,
    [id]
  );
  const flags = flagsRes.rows[0] ?? { has_children: false, commande_id: null, commande_numero: null };
  const enrichedDevis = {
    ...devis,
    allowed_statut_transitions: [...DEVIS_STATUT_TRANSITIONS[statutCourant]],
    has_children: flags.has_children,
    converted_commande:
      flags.commande_id !== null
        ? { id: toInt(flags.commande_id, "commande_client.id"), numero: flags.commande_numero ?? "" }
        : null,
  };

  return { devis: enrichedDevis, lignes: lignesWithPreparatory, documents };
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
        COALESCE(to_jsonb(ad)->>'created_at', to_jsonb(ad)->>'updated_at', now()::text) AS created_at,
        COALESCE(to_jsonb(ad)->>'updated_at', to_jsonb(ad)->>'created_at', now()::text) AS updated_at
      FROM public.article_devis ad
      WHERE ad.devis_id = $1::bigint
      ORDER BY ((to_jsonb(ad)->>'created_at')::timestamptz) ASC NULLS LAST, ad.id ASC
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
        COALESCE(to_jsonb(dd)->>'created_at', to_jsonb(dd)->>'updated_at', now()::text) AS created_at,
        COALESCE(to_jsonb(dd)->>'updated_at', to_jsonb(dd)->>'created_at', now()::text) AS updated_at
      FROM public.dossier_technique_piece_devis dd
      WHERE dd.devis_id = $1::bigint
      ORDER BY ((to_jsonb(dd)->>'created_at')::timestamptz) ASC NULLS LAST, dd.id ASC
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
      ORDER BY ((to_jsonb(article_devis)->>'created_at')::timestamptz) ASC NULLS LAST, id ASC
    `,
    [sourceDevisId]
  );

  if (sourceArticles.rows.length === 0) return;

  const lineMapRes = await client.query<{ source_line_id: string; target_line_id: string }>(
    `
      WITH src AS (
        SELECT dl.id, row_number() OVER (ORDER BY dl.id ASC) AS rn
        FROM public.devis_ligne dl
        WHERE dl.devis_id = $1::bigint
      ), tgt AS (
        SELECT dl.id, row_number() OVER (ORDER BY dl.id ASC) AS rn
        FROM public.devis_ligne dl
        WHERE dl.devis_id = $2::bigint
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
      ORDER BY ((to_jsonb(dossier_technique_piece_devis)->>'created_at')::timestamptz) ASC NULLS LAST, id ASC
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

export async function repoCreateDevis(
  input: CreateDevisBodyDTO,
  userId: number,
  documents: UploadedDocument[],
  ctx: DevisWriteContext = {}
) {
  const client = await pool.connect();
  const idempotencyPayloadHash = ctx.idempotency_key
    ? devisIdempotencyPayloadHash({ input, documents: documents.map((d) => d.originalname) })
    : null;
  try {
    await client.query("BEGIN");

    if (ctx.idempotency_key && idempotencyPayloadHash && (await hasDevisIdempotenceTable(client))) {
      const replay = await readDevisIdempotentReplay(client, ctx.idempotency_key, "CREATE", idempotencyPayloadHash);
      if (replay) {
        await client.query("COMMIT");
        return replay as { id: number; idempotent_replay: true };
      }
    }

    // #167 : l'automate démarre en BROUILLON ; ENVOYE reste accepté (saisie a posteriori
    // d'une offre déjà partie). Naître ACCEPTE/REFUSE/EXPIRE/ANNULE contournerait l'automate.
    if (input.statut !== "BROUILLON" && input.statut !== "ENVOYE") {
      throw new HttpError(
        422,
        "DEVIS_INITIAL_STATUT_INVALID",
        "Un devis se crée en BROUILLON (ou ENVOYE) ; les issues commerciales passent par les transitions.",
        { statut: input.statut }
      );
    }

    const seq = await client.query<{ id: string }>(`SELECT nextval('public.devis_id_seq')::bigint::text AS id`);
    const idRaw = seq.rows[0]?.id;
    if (!idRaw) throw new Error("Failed to allocate devis id");
    const devisId = toInt(idRaw, "devis.id");

    // The quote number is allocated atomically by the server.  Incoming values
    // are display hints only and must not become identifiers.
    const numero = await generateDevisCode(client, {
      client_id: input.client_id,
      date: input.date_creation ? new Date(input.date_creation) : undefined,
    });
    const dateCreation = (input.date_creation ?? new Date().toISOString().slice(0, 10)).slice(0, 10);

    // Totaux recalculés côté serveur — les totaux envoyés par le client sont ignorés (ISO A.8.28).
    const totals = computeDevisTotals(input.lignes, input.remise_globale ?? 0);

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
        totals.remise_pct,
        totals.total_ht,
        totals.total_ttc,
        input.commentaires ?? null,
        input.conditions_paiement_id ?? null,
        input.biller_id ?? null,
      ]
    );

    await insertDevisLines(client, devisId, input.lignes);
    await insertDevisDocuments(client, devisId, documents);

    await insertDevisAuditLog(client, ctx.audit, {
      action: "devis.create",
      entity_id: String(devisId),
      details: {
        numero,
        client_id: input.client_id,
        statut: input.statut,
        nb_lignes: input.lignes.length,
        nb_documents: documents.length,
        idempotency_key: ctx.idempotency_key ?? null,
      },
    });

    const inserted = ins.rows[0]?.id;
    const resultat = { id: inserted ? toInt(inserted, "devis.id") : devisId };
    if (ctx.idempotency_key && idempotencyPayloadHash && (await hasDevisIdempotenceTable(client))) {
      await recordDevisIdempotence(client, ctx.idempotency_key, "CREATE", resultat.id, idempotencyPayloadHash, resultat);
    }

    await client.query("COMMIT");
    return { ...resultat, idempotent_replay: false };
  } catch (err) {
    await client.query("ROLLBACK");
    const { code, constraint } = getPgErrorInfo(err);
    if (code === "23505" && constraint === "devis_numero_key") {
      throw new HttpError(409, "DEVIS_NUMERO_EXISTS", "Numero already exists");
    }
    // Course concurrente sur la même clé : l'autre transaction a gagné -> rejouer son résultat.
    if (ctx.idempotency_key && idempotencyPayloadHash && code === "23505" && constraint === "devis_idempotence_pkey") {
      const replay = await readDevisIdempotentReplay(pool, ctx.idempotency_key, "CREATE", idempotencyPayloadHash);
      if (replay) return replay as { id: number; idempotent_replay: true };
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Champs de contenu commercial : figés dès qu'un devis est engagé (révision obligatoire). */
const DEVIS_CONTENT_FIELDS = [
  "client_id",
  "contact_id",
  "adresse_facturation_id",
  "adresse_livraison_id",
  "mode_reglement_id",
  "compte_vente_id",
  "date_creation",
  "date_validite",
  "remise_globale",
  "commentaires",
  "conditions_paiement_id",
  "biller_id",
] as const satisfies readonly (keyof UpdateDevisBodyDTO)[];

export async function repoUpdateDevis(
  id: number,
  input: UpdateDevisBodyDTO,
  userId: number,
  documents: UploadedDocument[],
  ctx: DevisWriteContext = {}
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // #167 : l'écriture démarre TOUJOURS par un verrou de la ligne + lecture de l'état
    // (statut courant, jeton de fraîcheur, descendance) — l'automate et l'immutabilité
    // se décident sur l'état verrouillé, pas sur ce que le client croit savoir.
    const currentRes = await client.query<{
      id: string;
      numero: string;
      statut: string;
      remise_globale: number;
      updated_at: string | null;
      has_children: boolean;
    }>(
      `
        SELECT
          d.id::text AS id,
          d.numero,
          d.statut,
          d.remise_globale::float8 AS remise_globale,
          to_jsonb(d)->>'updated_at' AS updated_at,
          EXISTS (SELECT 1 FROM devis child WHERE child.parent_devis_id = d.id) AS has_children
        FROM devis d
        WHERE d.id = $1
        FOR UPDATE OF d
      `,
      [id]
    );
    const current = currentRes.rows[0] ?? null;
    if (!current) {
      await client.query("ROLLBACK");
      return null;
    }

    assertDevisFresh(input.expected_updated_at, current.updated_at);

    if (input.numero !== undefined && input.numero !== current.numero) {
      throw new HttpError(409, "DEVIS_CODE_IMMUTABLE", "Le numéro de devis est attribué par le serveur et ne peut pas être modifié.");
    }

    const currentStatut = normalizeDevisStatut(current.statut);
    const requestedStatut: DevisStatut | undefined = input.statut;
    const statutChanges = requestedStatut !== undefined && requestedStatut !== currentStatut;

    const hasContentChanges =
      DEVIS_CONTENT_FIELDS.some((key) => input[key] !== undefined) ||
      input.lignes !== undefined ||
      documents.length > 0;

    // Une version remplacée par une révision est immuable et consultable — rien ne s'y écrit.
    if (current.has_children && (hasContentChanges || statutChanges)) {
      throw new HttpError(
        409,
        "DEVIS_VERSION_SUPERSEDED",
        "Cette version a été remplacée par une révision : elle est immuable. Ouvrez la dernière version.",
        { devis_id: id }
      );
    }

    // Un devis engagé (non brouillon) ne s'écrase pas : seule une transition de statut
    // est permise ici ; toute modification de contenu passe par une révision.
    if (currentStatut !== "BROUILLON" && hasContentChanges) {
      throw new HttpError(
        409,
        "DEVIS_ENGAGED_IMMUTABLE",
        "Ce devis est engagé : créez une révision au lieu de modifier la version en place.",
        { statut: currentStatut }
      );
    }

    if (statutChanges && !canTransitionDevisStatut(currentStatut, requestedStatut)) {
      throw new HttpError(
        409,
        "DEVIS_INVALID_TRANSITION",
        `Transition ${currentStatut} → ${requestedStatut} refusée par l'automate devis.`,
        { from: currentStatut, to: requestedStatut, allowed: DEVIS_STATUT_TRANSITIONS[currentStatut] }
      );
    }

    // RBAC fin dépendant de l'état (pattern #172) : re-vérifié ici, l'état source étant connu.
    if (statutChanges && ctx.audit) {
      const capability = capabilityForDevisTransition(currentStatut, requestedStatut);
      if (!roleHasDevisCapability(ctx.audit.role, capability)) {
        throw new HttpError(403, "FORBIDDEN_TRANSITION", "Votre rôle ne permet pas cette transition de devis.");
      }
    }

    const sets: string[] = [];
    const values: unknown[] = [id];
    const push = (v: unknown) => {
      values.push(v);
      return `$${values.length}`;
    };

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
    if (input.commentaires !== undefined) sets.push(`commentaires = ${push(input.commentaires)}`);
    if (input.conditions_paiement_id !== undefined)
      sets.push(`conditions_paiement_id = ${push(input.conditions_paiement_id)}::int`);
    if (input.biller_id !== undefined) sets.push(`biller_id = ${push(input.biller_id)}::uuid`);

    // Totaux : recalcul serveur systématique (CA-APP-01) — les totaux du client sont ignorés.
    if (input.lignes !== undefined || input.remise_globale !== undefined) {
      const remise = input.remise_globale ?? current.remise_globale ?? 0;
      let effectiveLines: readonly { quantite: number; prix_unitaire_ht: number; remise_ligne?: number | null; taux_tva?: number | null }[];
      if (input.lignes !== undefined) {
        effectiveLines = input.lignes;
      } else {
        const existingLines = await client.query<{
          quantite: number;
          prix_unitaire_ht: number;
          remise_ligne: number | null;
          taux_tva: number | null;
        }>(
          `SELECT quantite::float8 AS quantite, prix_unitaire_ht::float8 AS prix_unitaire_ht,
                  remise_ligne::float8 AS remise_ligne, taux_tva::float8 AS taux_tva
           FROM devis_ligne WHERE devis_id = $1`,
          [id]
        );
        effectiveLines = existingLines.rows;
      }
      const totals = computeDevisTotals(effectiveLines, remise);
      sets.push(`total_ht = ${push(totals.total_ht)}`);
      sets.push(`total_ttc = ${push(totals.total_ttc)}`);
    }

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

    if (statutChanges) {
      await insertDevisAuditLog(client, ctx.audit, {
        action: "devis.statut_transition",
        entity_id: String(id),
        details: { numero: current.numero, from: currentStatut, to: requestedStatut },
      });
    }
    if (hasContentChanges) {
      await insertDevisAuditLog(client, ctx.audit, {
        action: "devis.update",
        entity_id: String(id),
        details: {
          numero: current.numero,
          fields: DEVIS_CONTENT_FIELDS.filter((key) => input[key] !== undefined),
          lignes_remplacees: input.lignes !== undefined,
          nb_documents: documents.length,
        },
      });
    }

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
  documents: UploadedDocument[],
  ctx: DevisWriteContext = {}
) {
  const client = await pool.connect();
  const idempotencyPayloadHash = ctx.idempotency_key
    ? devisIdempotencyPayloadHash({ source_devis_id: id, input, documents: documents.map((d) => d.originalname) })
    : null;
  try {
    await client.query("BEGIN");

    if (ctx.idempotency_key && idempotencyPayloadHash && (await hasDevisIdempotenceTable(client))) {
      const replay = await readDevisIdempotentReplay(client, ctx.idempotency_key, "REVISE", idempotencyPayloadHash);
      if (replay) {
        await client.query("COMMIT");
        return replay as {
          id: number;
          root_devis_id: number;
          parent_devis_id: number;
          version_number: number;
          idempotent_replay: true;
        };
      }
    }

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
      updated_at: string | null;
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
          biller_id::text AS biller_id,
          to_jsonb(devis)->>'updated_at' AS updated_at
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

    // #167 : la révision part de la version que l'utilisateur avait sous les yeux.
    assertDevisFresh(input.expected_updated_at, source.updated_at);

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

    if (input.numero !== undefined && input.numero !== source.numero) {
      throw new HttpError(409, "DEVIS_CODE_IMMUTABLE", "Le numéro de devis est attribué par le serveur et ne peut pas être modifié.");
    }
    // A revision receives a server-computed suffix because `devis.numero` is
    // unique.  The client cannot choose that suffix; `version_number` remains
    // the authoritative revision field.
    const numero = `${source.numero}-V${nextVersion}`.slice(0, 30);
    const dateCreation = (input.date_creation ?? new Date().toISOString().slice(0, 10)).slice(0, 10);

    // #167 : une révision repart dans l'entonnoir commercial (BROUILLON par défaut) ;
    // seuls BROUILLON/ENVOYE sont admis à la naissance d'une version.
    const revisionStatut: DevisStatut = input.statut ?? "BROUILLON";
    if (revisionStatut !== "BROUILLON" && revisionStatut !== "ENVOYE") {
      throw new HttpError(
        422,
        "DEVIS_REVISION_STATUT_INVALID",
        "Une révision naît en BROUILLON (ou ENVOYE) ; les issues commerciales passent par les transitions.",
        { statut: revisionStatut }
      );
    }

    // Totaux recalculés côté serveur. Si de nouvelles lignes sont fournies, on recalcule ;
    // sinon les lignes sont clonées de la source et on conserve ses totaux (ISO A.8.28).
    const revisedRemise = input.remise_globale ?? source.remise_globale ?? 0;
    const revisedTotals = input.lignes
      ? computeDevisTotals(input.lignes, revisedRemise)
      : { remise_pct: revisedRemise, total_ht: source.total_ht, total_ttc: source.total_ttc };

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
        revisionStatut,
        revisedTotals.remise_pct,
        revisedTotals.total_ht,
        revisedTotals.total_ttc,
        input.commentaires !== undefined ? input.commentaires : source.commentaires,
        input.conditions_paiement_id !== undefined ? input.conditions_paiement_id : source.conditions_paiement_id,
        input.biller_id !== undefined ? input.biller_id : source.biller_id,
      ]
    );

    if (input.lignes) {
      await insertDevisLines(client, newDevisId, input.lignes);
    } else {
      // Clone : la position et les totaux de ligne suivent la source (colonnes gardées —
      // patch 20260722 / schéma legacy).
      const hasPositionColumn = await hasPublicColumn(client, "devis_ligne", "position");
      const hasLineTotalsColumns =
        (await hasPublicColumn(client, "devis_ligne", "total_ht")) &&
        (await hasPublicColumn(client, "devis_ligne", "total_ttc"));
      const extraColumns = [
        ...(hasPositionColumn ? ["position"] : []),
        ...(hasLineTotalsColumns ? ["total_ht", "total_ttc"] : []),
      ];
      const extraSelects = [
        ...(hasPositionColumn ? ["dl.position"] : []),
        ...(hasLineTotalsColumns ? ["dl.total_ht", "dl.total_ttc"] : []),
      ];
      const orderClause = hasPositionColumn ? "dl.position ASC NULLS LAST, dl.id ASC" : "dl.id ASC";
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
            taux_tva${extraColumns.length ? `,\n            ${extraColumns.join(",\n            ")}` : ""}
          )
          SELECT
            $1,
            dl.description,
            dl.article_id,
            dl.piece_technique_id,
            dl.code_piece,
            dl.quantite,
            dl.unite,
            dl.prix_unitaire_ht,
            dl.remise_ligne,
            dl.taux_tva${extraSelects.length ? `,\n            ${extraSelects.join(",\n            ")}` : ""}
          FROM devis_ligne dl
          WHERE dl.devis_id = $2
          ORDER BY ${orderClause}
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

    const newId = inserted.rows[0]?.id;
    const resultat = {
      id: newId ? toInt(newId, "devis.id") : newDevisId,
      root_devis_id: rootDevisId,
      parent_devis_id: id,
      version_number: nextVersion,
    };

    await insertDevisAuditLog(client, ctx.audit, {
      action: "devis.revise",
      entity_id: String(resultat.id),
      details: {
        numero,
        source_devis_id: id,
        source_numero: source.numero,
        root_devis_id: rootDevisId,
        version_number: nextVersion,
        statut: revisionStatut,
        lignes_fournies: input.lignes !== undefined,
        idempotency_key: ctx.idempotency_key ?? null,
      },
    });

    if (ctx.idempotency_key && idempotencyPayloadHash && (await hasDevisIdempotenceTable(client))) {
      await recordDevisIdempotence(client, ctx.idempotency_key, "REVISE", resultat.id, idempotencyPayloadHash, resultat);
    }

    await client.query("COMMIT");
    return { ...resultat, idempotent_replay: false };
  } catch (err) {
    await client.query("ROLLBACK");
    const { code, constraint } = getPgErrorInfo(err);
    if (code === "23505" && constraint === "devis_numero_key") {
      throw new HttpError(409, "DEVIS_NUMERO_EXISTS", "Numero already exists");
    }
    if (ctx.idempotency_key && idempotencyPayloadHash && code === "23505" && constraint === "devis_idempotence_pkey") {
      const replay = await readDevisIdempotentReplay(pool, ctx.idempotency_key, "REVISE", idempotencyPayloadHash);
      if (replay) {
        return replay as {
          id: number;
          root_devis_id: number;
          parent_devis_id: number;
          version_number: number;
          idempotent_replay: true;
        };
      }
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
        to_jsonb(d)->>'updated_at' AS updated_at,
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
      ORDER BY ((to_jsonb(d)->>'updated_at')::timestamptz) DESC NULLS LAST, d.date_creation DESC, d.id DESC
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

export type ConvertDevisResult = {
  id: number;
  numero: string;
  devis_id: number;
  already_converted: boolean;
  idempotent_replay: boolean;
};

/**
 * #167 — conversion contrôlée : cette voie DÉLÈGUE la création au moteur unique
 * `repoCreateCommande` (module commande-client) — mêmes garanties que le parcours
 * préparé : fraîcheur atomique (DEVIS_DRAFT_STALE), officialisation des entités
 * préparatoires, échéances, checkpoints de workflow, snapshot et lien source.
 * L'orchestrateur n'ouvre PAS sa propre transaction : un FOR UPDATE ici bloquerait
 * le FK KEY SHARE pris par la transaction du moteur sur la ligne devis. L'unicité
 * `commande_client_devis_id_key` absorbe les courses (double clic / deux onglets
 * -> la même commande est retournée, jamais un doublon).
 */
export async function repoConvertDevisToCommande(
  devisId: number,
  opts: { expected_updated_at?: string } & DevisWriteContext = {}
): Promise<ConvertDevisResult | null> {
  const idempotencyPayloadHash = opts.idempotency_key
    ? devisIdempotencyPayloadHash({ devis_id: devisId, expected_updated_at: opts.expected_updated_at ?? null })
    : null;
  const idempotenceReady = Boolean(opts.idempotency_key && idempotencyPayloadHash) && (await hasDevisIdempotenceTable(pool));

  if (opts.idempotency_key && idempotencyPayloadHash && idempotenceReady) {
    const replay = await readDevisIdempotentReplay(pool, opts.idempotency_key, "CONVERT", idempotencyPayloadHash);
    if (replay) return replay as unknown as ConvertDevisResult;
  }

  const findExisting = async (): Promise<ConvertDevisResult | null> => {
    const existing = await pool.query<{ id: string; numero: string }>(
      `
      SELECT cc.id::text AS id, cc.numero
      FROM commande_client cc
      WHERE cc.devis_id = $1
      LIMIT 1
      `,
      [devisId]
    );
    const row = existing.rows[0];
    if (!row) return null;
    return {
      id: toInt(row.id, "commande_client.id"),
      numero: row.numero,
      devis_id: devisId,
      already_converted: true,
      idempotent_replay: false,
    };
  };

  const recordConvertIdempotence = async (resultat: ConvertDevisResult) => {
    if (opts.idempotency_key && idempotencyPayloadHash && idempotenceReady) {
      await recordConvertedDevisIdempotence(pool, opts.idempotency_key, devisId, idempotencyPayloadHash, resultat);
    }
  };

  const devis = await loadDevisCommandeHeader(pool, devisId);
  if (!devis) return null;

  // Idempotence métier AVANT toute autre garde : une commande existe déjà pour ce devis
  // -> on la retourne et on l'ouvre côté client, jamais de doublon (#167).
  const alreadyConverted = await findExisting();
  if (alreadyConverted) {
    await recordConvertIdempotence(alreadyConverted);
    return alreadyConverted;
  }

  if (!isAcceptedStatus(devis.statut)) {
    throw new HttpError(400, "DEVIS_NOT_ACCEPTED", "Devis must be accepted before conversion");
  }

  // Pré-contrôle rapide de fraîcheur (message immédiat) ; la vérification FAISANT FOI
  // est rejouée atomiquement dans la transaction du moteur (assertDevisDraftIsFresh).
  assertDevisFresh(opts.expected_updated_at, devis.updated_at, "DEVIS_DRAFT_STALE");

  // L'aperçu serveur EST la source de la conversion : mêmes lignes, mêmes résolutions
  // article/pièce, mêmes liens préparatoires que « Préparer la commande ».
  const draftBundle = await repoGetCommandeDraftFromDevis(devisId);
  if (!draftBundle) return null;
  const draft = draftBundle.draft;

  if (!Array.isArray(draft.lignes) || draft.lignes.length === 0) {
    throw new HttpError(400, "DEVIS_EMPTY", "Devis has no lines to convert");
  }

  const hasPreparatory = draft.lignes.some((ligne) =>
    Boolean((ligne as { source_article_devis_id?: string | null }).source_article_devis_id)
  );

  const input: CreateCommandeInput = {
    ...draft,
    date_commande: draft.date_commande ?? new Date().toISOString().slice(0, 10),
    // Verrou de version : la conversion cible exactement la version vue dans l'aperçu.
    source_devis_updated_at: opts.expected_updated_at ?? draft.source_devis_updated_at ?? devis.updated_at,
    // L'officialisation est EXPLICITE : l'aperçu de conversion l'annonce avant confirmation.
    officialize_preparatory_data: hasPreparatory,
  };

  let createdId: number;
  try {
    const created = await repoCreateCommande(input, []);
    createdId = created.id;
  } catch (err) {
    if (err instanceof HttpError && err.code === "DEVIS_ALREADY_CONVERTED") {
      // Course concurrente : une autre transaction a converti ce devis pendant la nôtre.
      const winner = await findExisting();
      if (winner) {
        await recordConvertIdempotence(winner);
        return winner;
      }
    }
    throw err;
  }

  const numeroRes = await pool.query<{ numero: string }>(`SELECT numero FROM commande_client WHERE id = $1 LIMIT 1`, [
    createdId,
  ]);
  const commandeNumero = numeroRes.rows[0]?.numero ?? "";

  const resultat: ConvertDevisResult = {
    id: createdId,
    numero: commandeNumero,
    devis_id: devisId,
    already_converted: false,
    idempotent_replay: false,
  };

  // Audit hors transaction moteur (le moteur journalise déjà historique + événements
  // commande) ; devis.convert relie devis, commande, clé d'idempotence et jeton de version.
  await insertDevisAuditLog(pool, opts.audit, {
    action: "devis.convert",
    entity_id: String(devisId),
    details: {
      devis_numero: devis.numero,
      commande_id: createdId,
      commande_numero: commandeNumero,
      officialized_preparatory: hasPreparatory,
      expected_updated_at: opts.expected_updated_at ?? null,
      idempotency_key: opts.idempotency_key ?? null,
    },
  });

  await recordConvertIdempotence(resultat);
  return resultat;
}

export async function repoDeleteDevis(id: number, ctx: DevisWriteContext = {}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const currentRes = await client.query<{
      numero: string;
      statut: string;
      has_children: boolean;
      converted: boolean;
    }>(
      `
        SELECT
          d.numero,
          d.statut,
          EXISTS (SELECT 1 FROM devis child WHERE child.parent_devis_id = d.id) AS has_children,
          EXISTS (SELECT 1 FROM commande_client cc WHERE cc.devis_id = d.id) AS converted
        FROM devis d
        WHERE d.id = $1
        FOR UPDATE OF d
      `,
      [id]
    );
    const current = currentRes.rows[0] ?? null;
    if (!current) {
      await client.query("ROLLBACK");
      return false;
    }

    // #167 : traçabilité d'abord — on ne supprime jamais un maillon de l'historique commercial.
    if (current.converted) {
      throw new HttpError(409, "DEVIS_CONVERTED_UNDELETABLE", "Ce devis a été converti en commande : il est conservé pour traçabilité.");
    }
    if (current.has_children) {
      throw new HttpError(409, "DEVIS_HAS_REVISIONS", "Ce devis a des révisions : supprimez d'abord les versions descendantes ou conservez l'historique.");
    }
    const statut = normalizeDevisStatut(current.statut);
    if (statut === "ENVOYE" || statut === "ACCEPTE") {
      throw new HttpError(409, "DEVIS_ENGAGED_UNDELETABLE", "Un devis engagé (envoyé/accepté) ne se supprime pas : annulez-le d'abord.", { statut });
    }

    const { rowCount } = await client.query(`DELETE FROM devis WHERE id = $1`, [id]);

    await insertDevisAuditLog(client, ctx.audit, {
      action: "devis.delete",
      entity_id: String(id),
      details: { numero: current.numero, statut },
    });

    await client.query("COMMIT");
    return (rowCount ?? 0) > 0;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export type DevisVersionSummary = {
  id: number;
  numero: string;
  version_number: number;
  parent_devis_id: number | null;
  statut: string;
  date_creation: string | null;
  updated_at: string | null;
  total_ht: number;
  total_ttc: number;
  is_current: boolean;
  is_latest: boolean;
  has_commande: boolean;
  commande_id: number | null;
  commande_numero: string | null;
};

/**
 * #167 : historique des versions d'une racine de devis (V1 → Vn), consultable depuis
 * n'importe quelle version. Lecture seule — alimente l'onglet Historique du hub.
 */
export async function repoListDevisVersions(devisId: number): Promise<DevisVersionSummary[] | null> {
  const rootRes = await pool.query<{ root_devis_id: string }>(
    `SELECT COALESCE(root_devis_id, id)::text AS root_devis_id FROM devis WHERE id = $1`,
    [devisId]
  );
  const rootRaw = rootRes.rows[0]?.root_devis_id;
  if (!rootRaw) return null;
  const rootId = toInt(rootRaw, "devis.root_devis_id");

  const res = await pool.query<{
    id: string;
    numero: string;
    version_number: number;
    parent_devis_id: string | null;
    statut: string;
    date_creation: string | null;
    updated_at: string | null;
    total_ht: number;
    total_ttc: number;
    commande_id: string | null;
    commande_numero: string | null;
  }>(
    `
      SELECT
        d.id::text AS id,
        d.numero,
        d.version_number::int AS version_number,
        d.parent_devis_id::text AS parent_devis_id,
        d.statut,
        d.date_creation::text AS date_creation,
        to_jsonb(d)->>'updated_at' AS updated_at,
        d.total_ht::float8 AS total_ht,
        d.total_ttc::float8 AS total_ttc,
        cc.id::text AS commande_id,
        cc.numero AS commande_numero
      FROM devis d
      LEFT JOIN commande_client cc ON cc.devis_id = d.id
      WHERE COALESCE(d.root_devis_id, d.id) = $1
      ORDER BY d.version_number ASC, d.id ASC
    `,
    [rootId]
  );

  const maxVersion = res.rows.reduce((max, row) => Math.max(max, row.version_number), 0);
  return res.rows.map((row) => {
    const idNum = toInt(row.id, "devis.id");
    return {
      id: idNum,
      numero: row.numero,
      version_number: row.version_number,
      parent_devis_id: toNullableInt(row.parent_devis_id, "devis.parent_devis_id"),
      statut: row.statut,
      date_creation: row.date_creation,
      updated_at: row.updated_at,
      total_ht: row.total_ht,
      total_ttc: row.total_ttc,
      is_current: idNum === devisId,
      is_latest: row.version_number === maxVersion,
      has_commande: row.commande_id !== null,
      commande_id: toNullableInt(row.commande_id, "commande_client.id"),
      commande_numero: row.commande_numero,
    };
  });
}
