// Traçabilité industrielle 360 (#142) — recherche universelle par CODE MÉTIER.
//
// Le module historique demandait à l'opérateur de saisir un UUID de lot. Un
// atelier ne connaît pas d'UUID : il connaît un code de lot gravé sur une
// étiquette, un numéro d'OF sur une fiche suiveuse, un numéro de BL sur un
// bordereau. Cette recherche prend ces codes-là.
//
// Sécurité : chaque source déclare son type de nœud, et le service retire les
// types que l'appelant n'a pas le droit de voir AVANT de renvoyer quoi que ce
// soit. L'autocomplétion ne révèle jamais l'existence d'un objet interdit.
//
// Performance : une seule requête `UNION ALL`, chaque branche bornée par
// `LIMIT`, recherche insensible à la casse et aux accents via `unaccent` quand
// l'extension existe, `lower()` sinon.

import pool from "../../../config/database";

import {
  NODE_TYPE_FAMILY,
  NODE_TYPE_LABELS,
  authoritativeRoute,
  nodeKey,
  type TraceabilityNodeType,
} from "../domain/traceability-model";
import { nodeTypeIsVisible, type TraceabilityCapabilitySet } from "../domain/traceability-policy";

export type TraceabilitySearchHit = {
  node_id: string;
  type: TraceabilityNodeType;
  type_label: string;
  family: string;
  id: string;
  code: string;
  label: string;
  status: string | null;
  date: string | null;
  context: string | null;
  route: string | null;
};

type Row = Record<string, unknown>;

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function iso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  const s = String(v).trim();
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toISOString();
}

let unaccentAvailable: boolean | null = null;

async function hasUnaccent(): Promise<boolean> {
  if (unaccentAvailable !== null) return unaccentAvailable;
  try {
    const res = await pool.query(
      `SELECT 1 FROM pg_extension WHERE extname = 'unaccent' LIMIT 1`
    );
    unaccentAvailable = (res?.rows?.length ?? 0) > 0;
  } catch {
    unaccentAvailable = false;
  }
  return unaccentAvailable;
}

/** Exposé pour les tests : réinitialise la détection d'extension. */
export function __resetUnaccentCache(): void {
  unaccentAvailable = null;
}

/**
 * Normalisation de la saisie opérateur : un code scanné arrive parfois avec des
 * espaces, un retour chariot du lecteur code-barres, ou en minuscules.
 * On ne « corrige » jamais le code au-delà de ça — inventer une correspondance
 * approximative serait fabriquer une traçabilité.
 */
export function normalizeSearchTerm(raw: string): string {
  return raw.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
}

/** `match(col)` normalise une colonne comme le terme saisi (minuscules, accents). */
type ColumnMatcher = (column: string) => string;

type SearchBranch = {
  type: TraceabilityNodeType;
  sql: (match: ColumnMatcher) => string;
};

/**
 * `$1` = motif LIKE préfixé/suffixé de `%`, déjà normalisé côté service.
 * `match(col)` applique la même normalisation à la colonne cible.
 */
const BRANCHES: SearchBranch[] = [
  {
    type: "lot",
    sql: (m) => `
      SELECT 'lot' AS type, l.id::text AS id, l.lot_code AS code,
             COALESCE(a.designation, a.code, l.lot_code) AS label,
             l.lot_status AS status,
             COALESCE(l.manufactured_at::text, l.received_at::text) AS date,
             NULLIF(CONCAT_WS(' · ', a.code, NULLIF(l.supplier_lot_code, '')), '') AS context,
             CASE WHEN ${m("l.lot_code")} = $2 THEN 0 ELSE 1 END AS rank
        FROM public.lots l
        LEFT JOIN public.articles a ON a.id = l.article_id
       WHERE ${m("l.lot_code")} LIKE $1
          OR ${m("COALESCE(l.supplier_lot_code, '')")} LIKE $1
       ORDER BY rank, l.created_at DESC
       LIMIT 25`,
  },
  {
    type: "of",
    sql: (m) => `
      SELECT 'of' AS type, o.id::text AS id, o.numero AS code,
             COALESCE(p.designation, p.code_piece, o.numero) AS label,
             o.statut::text AS status,
             COALESCE(o.date_lancement_reelle::text, o.date_lancement_prevue::text) AS date,
             NULLIF(CONCAT_WS(' · ', p.code_piece, af.reference), '') AS context,
             CASE WHEN ${m("o.numero")} = $2 THEN 0 ELSE 1 END AS rank
        FROM public.ordres_fabrication o
        LEFT JOIN public.pieces_techniques p ON p.id = o.piece_technique_id
        LEFT JOIN public.affaire af ON af.id = o.affaire_id
       WHERE ${m("o.numero")} LIKE $1
       ORDER BY rank, o.id DESC
       LIMIT 25`,
  },
  {
    type: "article",
    sql: (m) => `
      SELECT 'article' AS type, a.id::text AS id, a.code AS code,
             a.designation AS label, a.status AS status, a.updated_at::text AS date,
             a.article_type AS context,
             CASE WHEN ${m("a.code")} = $2 THEN 0 ELSE 1 END AS rank
        FROM public.articles a
       WHERE ${m("a.code")} LIKE $1
          OR ${m("COALESCE(a.designation, '')")} LIKE $1
       ORDER BY rank, a.code ASC
       LIMIT 25`,
  },
  {
    type: "piece_technique",
    sql: (m) => `
      SELECT 'piece_technique' AS type, p.id::text AS id, p.code_piece AS code,
             p.designation AS label, p.statut AS status, p.updated_at::text AS date,
             p.client_name AS context,
             CASE WHEN ${m("COALESCE(p.code_piece, '')")} = $2 THEN 0 ELSE 1 END AS rank
        FROM public.pieces_techniques p
       WHERE p.deleted_at IS NULL
         AND (${m("COALESCE(p.code_piece, '')")} LIKE $1
              OR ${m("COALESCE(p.designation, '')")} LIKE $1)
       ORDER BY rank, p.code_piece ASC
       LIMIT 25`,
  },
  {
    type: "bon_livraison",
    sql: (m) => `
      SELECT 'bon_livraison' AS type, bl.id::text AS id, bl.numero AS code,
             COALESCE(c.company_name, bl.numero) AS label,
             bl.statut AS status,
             COALESCE(bl.date_livraison::text, bl.date_expedition::text, bl.date_creation::text) AS date,
             bl.tracking_number AS context,
             CASE WHEN ${m("bl.numero")} = $2 THEN 0 ELSE 1 END AS rank
        FROM public.bon_livraison bl
        LEFT JOIN public.clients c ON c.client_id = bl.client_id
       WHERE ${m("bl.numero")} LIKE $1
          OR ${m("COALESCE(bl.tracking_number, '')")} LIKE $1
       ORDER BY rank, bl.date_creation DESC
       LIMIT 25`,
  },
  {
    type: "reception_fournisseur",
    sql: (m) => `
      SELECT 'reception_fournisseur' AS type, r.id::text AS id, r.reception_no AS code,
             COALESCE(f.raison_sociale, f.nom, r.reception_no) AS label,
             r.status AS status, r.reception_date::text AS date,
             r.supplier_reference AS context,
             CASE WHEN ${m("r.reception_no")} = $2 THEN 0 ELSE 1 END AS rank
        FROM public.receptions_fournisseurs r
        LEFT JOIN public.fournisseurs f ON f.id = r.fournisseur_id
       WHERE ${m("r.reception_no")} LIKE $1
          OR ${m("COALESCE(r.supplier_reference, '')")} LIKE $1
       ORDER BY rank, r.reception_date DESC
       LIMIT 25`,
  },
  {
    type: "commande_fournisseur",
    sql: (m) => `
      SELECT 'commande_fournisseur' AS type, cf.id::text AS id, cf.code AS code,
             COALESCE(f.raison_sociale, f.nom, cf.code) AS label,
             cf.statut AS status, cf.created_at::text AS date,
             cf.reference_fournisseur AS context,
             CASE WHEN ${m("cf.code")} = $2 THEN 0 ELSE 1 END AS rank
        FROM public.commande_fournisseur cf
        LEFT JOIN public.fournisseurs f ON f.id = cf.fournisseur_id
       WHERE ${m("cf.code")} LIKE $1
          OR ${m("COALESCE(cf.reference_fournisseur, '')")} LIKE $1
       ORDER BY rank, cf.created_at DESC
       LIMIT 25`,
  },
  {
    type: "commande",
    sql: (m) => `
      SELECT 'commande' AS type, cc.id::text AS id, cc.numero AS code,
             COALESCE(c.company_name, cc.numero) AS label,
             cc.order_type AS status, cc.date_commande::text AS date,
             cc.code_client AS context,
             CASE WHEN ${m("cc.numero")} = $2 THEN 0 ELSE 1 END AS rank
        FROM public.commande_client cc
        LEFT JOIN public.clients c ON c.client_id = cc.client_id
       WHERE ${m("cc.numero")} LIKE $1
       ORDER BY rank, cc.date_commande DESC
       LIMIT 25`,
  },
  {
    type: "affaire",
    sql: (m) => `
      SELECT 'affaire' AS type, af.id::text AS id, af.reference AS code,
             COALESCE(c.company_name, af.reference) AS label,
             af.statut AS status, af.date_ouverture::text AS date,
             af.type_affaire AS context,
             CASE WHEN ${m("af.reference")} = $2 THEN 0 ELSE 1 END AS rank
        FROM public.affaire af
        LEFT JOIN public.clients c ON c.client_id = af.client_id
       WHERE ${m("af.reference")} LIKE $1
       ORDER BY rank, af.date_ouverture DESC
       LIMIT 25`,
  },
  {
    type: "non_conformity",
    sql: (m) => `
      SELECT 'non_conformity' AS type, nc.id::text AS id, nc.reference AS code,
             LEFT(COALESCE(nc.description, nc.reference), 120) AS label,
             nc.status::text AS status, nc.detection_date::text AS date,
             nc.severity::text AS context,
             CASE WHEN ${m("nc.reference")} = $2 THEN 0 ELSE 1 END AS rank
        FROM public.non_conformity nc
       WHERE ${m("nc.reference")} LIKE $1
       ORDER BY rank, nc.detection_date DESC
       LIMIT 25`,
  },
  {
    type: "derogation",
    sql: (m) => `
      SELECT 'derogation' AS type, d.id::text AS id, d.code AS code,
             LEFT(COALESCE(d.deviation, d.code), 120) AS label,
             d.status AS status, COALESCE(d.approved_at::text, d.requested_at::text) AS date,
             d.derogation_type AS context,
             CASE WHEN ${m("d.code")} = $2 THEN 0 ELSE 1 END AS rank
        FROM public.quality_derogation d
       WHERE ${m("d.code")} LIKE $1
       ORDER BY rank, d.created_at DESC
       LIMIT 25`,
  },
  {
    type: "quality_control",
    sql: (m) => `
      SELECT 'quality_control' AS type, qc.id::text AS id,
             COALESCE(qc.reference, qc.id::text) AS code,
             ('Contrôle ' || COALESCE(qc.control_type::text, '')) AS label,
             qc.status::text AS status, qc.control_date::text AS date,
             qc.verdict AS context,
             CASE WHEN ${m("COALESCE(qc.reference, '')")} = $2 THEN 0 ELSE 1 END AS rank
        FROM public.quality_control qc
       WHERE ${m("COALESCE(qc.reference, '')")} LIKE $1
       ORDER BY rank, qc.control_date DESC
       LIMIT 25`,
  },
  {
    type: "metrology_equipment",
    sql: (m) => `
      SELECT 'metrology_equipment' AS type, e.id::text AS id, e.code AS code,
             e.designation AS label, COALESCE(e.etat, e.statut) AS status,
             e.updated_at::text AS date, e.numero_serie AS context,
             CASE WHEN ${m("e.code")} = $2 THEN 0 ELSE 1 END AS rank
        FROM public.metrologie_equipements e
       WHERE e.deleted_at IS NULL
         AND (${m("e.code")} LIKE $1
              OR ${m("COALESCE(e.numero_serie, '')")} LIKE $1
              OR ${m("COALESCE(e.designation, '')")} LIKE $1)
       ORDER BY rank, e.code ASC
       LIMIT 25`,
  },
  {
    type: "metrology_certificate",
    sql: (m) => `
      SELECT 'metrology_certificate' AS type, c.id::text AS id,
             COALESCE(c.numero_externe, c.id::text) AS code,
             ('Certificat ' || COALESCE(c.document_kind, '')) AS label,
             COALESCE(c.statut, c.resultat) AS status, c.date_etalonnage::text AS date,
             c.organisme AS context,
             CASE WHEN ${m("COALESCE(c.numero_externe, '')")} = $2 THEN 0 ELSE 1 END AS rank
        FROM public.metrologie_certificats c
       WHERE c.deleted_at IS NULL
         AND (${m("COALESCE(c.numero_externe, '')")} LIKE $1
              OR ${m("COALESCE(c.sha256, '')")} LIKE $1)
       ORDER BY rank, c.date_etalonnage DESC
       LIMIT 25`,
  },
  {
    type: "devis",
    sql: (m) => `
      SELECT 'devis' AS type, d.id::text AS id, d.numero AS code,
             COALESCE(c.company_name, d.numero) AS label,
             d.statut::text AS status, d.date_creation::text AS date,
             NULL::text AS context,
             CASE WHEN ${m("d.numero")} = $2 THEN 0 ELSE 1 END AS rank
        FROM public.devis d
        LEFT JOIN public.clients c ON c.client_id = d.client_id
       WHERE ${m("d.numero")} LIKE $1
       ORDER BY rank, d.date_creation DESC
       LIMIT 25`,
  },
];

export type SearchParams = {
  term: string;
  caps: TraceabilityCapabilitySet;
  types: ReadonlySet<TraceabilityNodeType> | null;
  limit: number;
  offset: number;
};

export type SearchResult = {
  hits: TraceabilitySearchHit[];
  has_more: boolean;
  searched_types: TraceabilityNodeType[];
};

export async function repoSearchTraceability(params: SearchParams): Promise<SearchResult> {
  const term = normalizeSearchTerm(params.term);
  if (term.length < 2) return { hits: [], has_more: false, searched_types: [] };

  const useUnaccent = await hasUnaccent();
  const match = (col: string) =>
    useUnaccent ? `unaccent(lower(${col}))` : `lower(${col})`;

  const branches = BRANCHES.filter((b) => {
    if (!nodeTypeIsVisible(params.caps, b.type)) return false;
    if (params.types && !params.types.has(b.type)) return false;
    return true;
  });

  if (!branches.length) return { hits: [], has_more: false, searched_types: [] };

  const normalized = term.toLowerCase();
  const like = `%${normalized.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;

  const sql = `
    ${branches.map((b) => `(${b.sql(match)})`).join("\n UNION ALL \n")}
  `;

  let rows: Row[] = [];
  try {
    const res = await pool.query(sql, [like, normalized]);
    rows = (res?.rows ?? []) as Row[];
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code !== "42P01" && code !== "42501" && code !== "42703") throw err;
    rows = [];
  }

  const all: TraceabilitySearchHit[] = [];
  for (const row of rows) {
    const type = str(row.type) as TraceabilityNodeType | null;
    const id = str(row.id);
    if (!type || !id) continue;
    const ref = { type, id };
    all.push({
      node_id: nodeKey(ref),
      type,
      type_label: NODE_TYPE_LABELS[type] ?? type,
      family: NODE_TYPE_FAMILY[type] ?? "preuve",
      id,
      code: str(row.code) ?? id,
      label: str(row.label) ?? str(row.code) ?? (NODE_TYPE_LABELS[type] ?? type),
      status: str(row.status),
      date: iso(row.date),
      context: str(row.context),
      route: authoritativeRoute(ref),
    });
  }

  // Tri stable : correspondance exacte d'abord, puis code, puis type. Le tri
  // final est fait ici et non en SQL : `UNION ALL` de sous-requêtes ordonnées
  // ne garantit pas d'ordre global, et un `ORDER BY` externe forcerait un tri
  // sur l'ensemble du résultat côté PostgreSQL.
  all.sort((a, b) => {
    const exactA = a.code.toLowerCase() === normalized ? 0 : 1;
    const exactB = b.code.toLowerCase() === normalized ? 0 : 1;
    if (exactA !== exactB) return exactA - exactB;
    const startsA = a.code.toLowerCase().startsWith(normalized) ? 0 : 1;
    const startsB = b.code.toLowerCase().startsWith(normalized) ? 0 : 1;
    if (startsA !== startsB) return startsA - startsB;
    return a.code.localeCompare(b.code, "fr");
  });

  const page = all.slice(params.offset, params.offset + params.limit);
  return {
    hits: page,
    has_more: all.length > params.offset + params.limit,
    searched_types: branches.map((b) => b.type),
  };
}
