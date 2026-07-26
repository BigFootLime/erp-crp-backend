// Traçabilité industrielle 360 (#142) — expansion de voisinage BATCHÉE.
//
// Contrat : une requête par (type de nœud × famille de relation × direction) et
// par NIVEAU de parcours, jamais une requête par nœud. Le moteur historique
// faisait deux requêtes par nœud visité (`repoListHardNeighbors` +
// `repoListTraceabilityLinks`) : ~240 allers-retours pour 120 nœuds. Ici, une
// chaîne de profondeur 4 coûte ~4 × (nombre de types présents) requêtes.
//
// Règle de preuve : chaque arête déclare `proof_level` et `proof_source`.
// - `proven`   → clé étrangère, mouvement comptabilisé, snapshot, ou
//                enregistrement métier autoritaire.
// - `declared` → référence documentaire libre (`source_document_type` /
//                `source_document_id`), vraie mais non contrainte.
// AUCUNE arête n'est fabriquée par rapprochement de codes, de textes, de dates
// proches ou de quantités supposées.

import pool from "../../../config/database";

import type { NeighborEdge } from "../domain/traceability-graph";
import {
  TRACEABILITY_NODE_TYPES,
  isBigintId,
  isUuid,
  type TraceabilityNodeRef,
  type TraceabilityNodeType,
  type TraceabilityProofLevel,
  type TraceabilityRelationType,
} from "../domain/traceability-model";
import { TRACEABILITY_LIMITS } from "../domain/traceability-policy";

/* -------------------------------------------------------------------------- */
/* Utilitaires                                                                */
/* -------------------------------------------------------------------------- */

type Row = Record<string, unknown>;

function str(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s.length ? s : null;
}

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  const s = String(value).trim();
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toISOString();
}

/**
 * Une table peut ne pas exister sur un environnement qui n'a pas encore reçu le
 * patch (`42P01`) ou ne pas être lisible par le rôle applicatif (`42501`, le
 * piège d'ownership documenté dans le runbook HYPERBOX2). Dans les deux cas la
 * chaîne doit rester lisible : on renvoie zéro voisin pour CETTE famille, on ne
 * renvoie pas une 500 pour tout le graphe. La lacune est ensuite visible dans
 * `coverage`, elle n'est pas masquée.
 */
async function safeQuery(sql: string, params: unknown[]): Promise<Row[]> {
  try {
    const res = await pool.query(sql, params);
    return (res?.rows ?? []) as Row[];
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "42P01" || code === "42501" || code === "42703") return [];
    throw err;
  }
}

const CAP = TRACEABILITY_LIMITS.MAX_NEIGHBORS_PER_NODE * 4;

/** Un type stocké en texte libre par la table historique peut ne plus exister. */
const NODE_TYPE_SET: ReadonlySet<string> = new Set(TRACEABILITY_NODE_TYPES);

type EdgeSpec = {
  direction: NeighborEdge["direction"];
  relation: TraceabilityRelationType;
  fromType: TraceabilityNodeType;
  toType: TraceabilityNodeType;
  proof: TraceabilityProofLevel;
  source: string;
};

/**
 * CONVENTION D'ARÊTE, non négociable pour tout le module :
 * `from` est TOUJOURS l'extrémité AMONT dans le flux industriel, `to`
 * l'extrémité AVAL. Une arête se lit donc toujours dans le sens de la matière,
 * quel que soit le côté par lequel on l'a découverte.
 *
 * Le nœud d'ancrage (celui qu'on était en train de déplier) n'est donc pas
 * toujours `from` : en parcours AMONT c'est `to`. Le moteur le déduit de
 * `direction`, ce qui évite d'inverser les libellés selon le sens de lecture.
 */
function toEdge(spec: EdgeSpec, row: Row): NeighborEdge | null {
  const fromId = str(row.from_id);
  const toId = str(row.to_id);
  if (!fromId || !toId) return null;
  return {
    direction: spec.direction,
    relation: spec.relation,
    from: { type: spec.fromType, id: fromId },
    to: { type: spec.toType, id: toId },
    proof_level: spec.proof,
    proof_source: spec.source,
    effective_at: iso(row.effective_at),
    qty: num(row.qty),
    unit: str(row.unit),
    correlation_id: str(row.correlation_id),
    evidence_ref: str(row.evidence_ref),
    historical_status: str(row.historical_status),
    meta: null,
  };
}

async function edgesFrom(spec: EdgeSpec, sql: string, params: unknown[]): Promise<NeighborEdge[]> {
  const rows = await safeQuery(sql, params);
  const out: NeighborEdge[] = [];
  for (const row of rows) {
    const edge = toEdge(spec, row);
    if (edge) out.push(edge);
  }
  return out;
}

function uuids(ids: string[]): string[] {
  return ids.filter(isUuid);
}

function bigints(ids: string[]): string[] {
  return ids.filter(isBigintId);
}

/* -------------------------------------------------------------------------- */
/* Contexte d'expansion                                                       */
/* -------------------------------------------------------------------------- */

export type NeighborContext = {
  /**
   * Direction qui porte les arêtes LATÉRALES (preuves attachées : contrôles,
   * NC, dérogations, documents). Elles ne sont émises qu'une fois pour ne pas
   * doubler le coût SQL quand l'appelant demande `both`.
   */
  lateralOn: "upstream" | "downstream";
  /** Date de référence : on n'affiche jamais une preuve postérieure à `as_of`. */
  asOf: string | null;
};

/* -------------------------------------------------------------------------- */
/* Expansion par type                                                         */
/* -------------------------------------------------------------------------- */

type Expander = (
  ids: string[],
  direction: "upstream" | "downstream",
  ctx: NeighborContext
) => Promise<NeighborEdge[]>;

/* ------------------------------- LOT -------------------------------------- */

const expandLot: Expander = async (rawIds, direction, ctx) => {
  const ids = uuids(rawIds);
  if (!ids.length) return [];
  const asOf = ctx.asOf;
  const out: NeighborEdge[] = [];

  if (direction === "upstream") {
    out.push(
      // Origine fournisseur : la ligne de réception qui a créé le lot.
      ...(await edgesFrom(
        {
          direction: "upstream",
          relation: "CREATED_LOT",
          fromType: "reception_ligne",
          toType: "lot",
          proof: "proven",
          source: "reception_fournisseur_lignes.lot_id",
        },
        `SELECT rl.id::text AS from_id, rl.lot_id::text AS to_id,
                rl.qty_received::float8 AS qty, rl.unite AS unit,
                r.reception_date::text AS effective_at, rl.id::text AS evidence_ref,
                r.status AS historical_status
           FROM public.reception_fournisseur_lignes rl
           JOIN public.receptions_fournisseurs r ON r.id = rl.reception_id
          WHERE rl.lot_id = ANY($1::uuid[])
            AND ($2::timestamptz IS NULL OR r.created_at <= $2::timestamptz)
          ORDER BY r.reception_date DESC
          LIMIT ${CAP}`,
        [ids, asOf]
      )),
      // Origine production : l'OF qui a déclaré ce lot en sortie.
      ...(await edgesFrom(
        {
          direction: "upstream",
          relation: "PRODUCED_BY",
          fromType: "of",
          toType: "lot",
          proof: "proven",
          source: "of_output_lots.lot_id",
        },
        `SELECT ool.of_id::text AS from_id, ool.lot_id::text AS to_id,
                ool.qty_ok::float8 AS qty, NULL::text AS unit,
                ool.created_at AS effective_at, ool.id::text AS evidence_ref,
                NULL::text AS historical_status
           FROM public.of_output_lots ool
          WHERE ool.lot_id = ANY($1::uuid[])
            AND ($2::timestamptz IS NULL OR ool.created_at <= $2::timestamptz)
          ORDER BY ool.created_at DESC
          LIMIT ${CAP}`,
        [ids, asOf]
      )),
      // Réception de production : la preuve d'entrée en stock du lot fabriqué.
      ...(await edgesFrom(
        {
          direction: "upstream",
          relation: "ISSUED_FROM",
          fromType: "of_receipt",
          toType: "lot",
          proof: "proven",
          source: "of_receipts.lot_id",
        },
        `SELECT rc.id::text AS from_id, rc.lot_id::text AS to_id,
                rc.qty_ok::float8 AS qty, NULL::text AS unit,
                rc.created_at AS effective_at, rc.id::text AS evidence_ref,
                rc.quality_status AS historical_status
           FROM public.of_receipts rc
          WHERE rc.lot_id = ANY($1::uuid[])
            AND ($2::timestamptz IS NULL OR rc.created_at <= $2::timestamptz)
          ORDER BY rc.created_at DESC
          LIMIT ${CAP}`,
        [ids, asOf]
      )),
      // Généalogie de lot : split / merge / transformation, déjà normalisée par #225.
      ...(await genealogyEdges(ids, "upstream", asOf)),
      // Article porteur : identité, pas flux — mais indispensable pour lire la chaîne.
      ...(await edgesFrom(
        {
          direction: "upstream",
          relation: "ARTICLE_OF",
          fromType: "article",
          toType: "lot",
          proof: "proven",
          source: "lots.article_id",
        },
        `SELECT l.article_id::text AS from_id, l.id::text AS to_id,
                NULL::float8 AS qty, a.unite AS unit,
                l.created_at AS effective_at, l.id::text AS evidence_ref,
                l.lot_status AS historical_status
           FROM public.lots l
           JOIN public.articles a ON a.id = l.article_id
          WHERE l.id = ANY($1::uuid[])
          LIMIT ${CAP}`,
        [ids]
      ))
    );
  } else {
    out.push(
      // Consommation matière : le maillon qui manquait à la chaîne.
      ...(await consumptionEdges(ids, "byLot", asOf)),
      // Réservations : engagement du lot vers un OF, une commande ou un BL.
      ...(await edgesFrom(
        {
          direction: "downstream",
          relation: "RESERVED_FOR",
          fromType: "lot",
          toType: "reservation",
          proof: "proven",
          source: "stock_reservations.lot_id",
        },
        `SELECT r.lot_id::text AS from_id, r.id::text AS to_id,
                r.qty_reserved::float8 AS qty, NULL::text AS unit,
                r.created_at AS effective_at, r.id::text AS evidence_ref,
                r.status AS historical_status, r.correlation_id::text AS correlation_id
           FROM public.stock_reservations r
          WHERE r.lot_id = ANY($1::uuid[])
            AND ($2::timestamptz IS NULL OR r.created_at <= $2::timestamptz)
          ORDER BY r.created_at DESC
          LIMIT ${CAP}`,
        [ids, asOf]
      )),
      // Mouvements comptabilisés portant ce lot.
      ...(await edgesFrom(
        {
          direction: "downstream",
          relation: "MOVED_BY",
          fromType: "lot",
          toType: "stock_movement",
          proof: "proven",
          source: "stock_movement_lines.lot_id",
        },
        `SELECT sl.lot_id::text AS from_id, sm.id::text AS to_id,
                sl.qty::float8 AS qty, sl.unite AS unit,
                COALESCE(sm.posted_at, sm.effective_at) AS effective_at,
                sl.id::text AS evidence_ref, sm.status AS historical_status,
                sm.correlation_id::text AS correlation_id
           FROM public.stock_movement_lines sl
           JOIN public.stock_movements sm ON sm.id = sl.movement_id
          WHERE sl.lot_id = ANY($1::uuid[])
            AND ($2::timestamptz IS NULL OR COALESCE(sm.posted_at, sm.effective_at) <= $2::timestamptz)
          ORDER BY COALESCE(sm.posted_at, sm.effective_at) DESC
          LIMIT ${CAP}`,
        [ids, asOf]
      )),
      // Allocation sur une ligne de bon de livraison.
      ...(await edgesFrom(
        {
          direction: "downstream",
          relation: "ALLOCATED_TO",
          fromType: "lot",
          toType: "bon_livraison_ligne",
          proof: "proven",
          source: "bon_livraison_ligne_allocations.lot_id",
        },
        `SELECT a.lot_id::text AS from_id, a.bon_livraison_ligne_id::text AS to_id,
                a.quantite::float8 AS qty, a.unite AS unit,
                a.created_at AS effective_at, a.id::text AS evidence_ref,
                NULL::text AS historical_status
           FROM public.bon_livraison_ligne_allocations a
          WHERE a.lot_id = ANY($1::uuid[])
            AND ($2::timestamptz IS NULL OR a.created_at <= $2::timestamptz)
          ORDER BY a.created_at DESC
          LIMIT ${CAP}`,
        [ids, asOf]
      )),
      ...(await genealogyEdges(ids, "downstream", asOf))
    );
  }

  if (direction === ctx.lateralOn) {
    out.push(...(await lateralEvidenceForLots(ids, asOf)));
  }

  return out;
};

async function genealogyEdges(
  ids: string[],
  direction: "upstream" | "downstream",
  asOf: string | null
): Promise<NeighborEdge[]> {
  // `stock_lot_genealogy_edges` (#225) est déjà la structure normalisée des
  // fractionnements, fusions et transformations : on la réutilise, on n'en
  // crée pas une seconde.
  const isUp = direction === "upstream";
  const rows = await safeQuery(
    `SELECT g.parent_lot_id::text AS from_id,
            g.child_lot_id::text AS to_id,
            g.operation_type, g.qty_contributed::float8 AS qty, g.unit_code AS unit,
            g.created_at AS effective_at, g.id::text AS evidence_ref,
            g.correlation_id::text AS correlation_id
       FROM public.stock_lot_genealogy_edges g
      WHERE ${isUp ? "g.child_lot_id" : "g.parent_lot_id"} = ANY($1::uuid[])
        AND ($2::timestamptz IS NULL OR g.created_at <= $2::timestamptz)
      ORDER BY g.created_at DESC
      LIMIT ${CAP}`,
    [ids, asOf]
  );

  const relationByOperation: Record<string, TraceabilityRelationType> = {
    SPLIT: "SPLIT_FROM",
    MERGE: "MERGED_FROM",
    TRANSFORM: "TRANSFORMED_FROM",
  };

  const out: NeighborEdge[] = [];
  for (const row of rows) {
    const op = str(row.operation_type) ?? "TRANSFORM";
    const edge = toEdge(
      {
        direction,
        relation: relationByOperation[op] ?? "TRANSFORMED_FROM",
        fromType: "lot",
        toType: "lot",
        proof: "proven",
        source: "stock_lot_genealogy_edges",
      },
      row
    );
    if (edge) {
      edge.correlation_id = str(row.correlation_id);
      edge.meta = { operation_type: op };
      out.push(edge);
    }
  }
  return out;
}

/**
 * Consommation matière — le maillon critique.
 *
 * Trois sources, par ordre décroissant de force de preuve :
 *  1. `of_material_consumptions` : l'enregistrement canonique écrit par
 *     l'automatisation à la comptabilisation d'une sortie (patch #142).
 *  2. `stock_reservations` consommées : FK `of_id` + `lot_id` +
 *     `consumed_stock_movement_id`. Preuve complète, antérieure au patch.
 *  3. Mouvements OUT comptabilisés déclarant `source_document_type = 'OF'` :
 *     référence documentaire libre, donc `declared` et jamais `proven`.
 *
 * Les trois cohabitent volontairement : elles portent des `evidence_ref`
 * distincts, donc l'UI affiche trois preuves du même fait plutôt qu'un fait
 * inventé. Aucune déduplication « intelligente » : ce serait deviner.
 */
async function consumptionEdges(
  ids: string[],
  by: "byLot" | "byOf",
  asOf: string | null
): Promise<NeighborEdge[]> {
  const out: NeighborEdge[] = [];
  const anchorIsLot = by === "byLot";
  const direction: "upstream" | "downstream" = anchorIsLot ? "downstream" : "upstream";

  // 1) Enregistrement canonique
  out.push(
    ...(await edgesFrom(
      {
        direction,
        relation: "CONSUMED_BY",
        fromType: "lot",
        toType: "of",
        proof: "proven",
        source: "of_material_consumptions",
      },
      `SELECT c.lot_id::text AS from_id,
              c.of_id::text AS to_id,
              c.qty::float8 AS qty, c.unit_code AS unit,
              c.effective_at AS effective_at, c.id::text AS evidence_ref,
              c.status AS historical_status, c.correlation_id::text AS correlation_id
         FROM public.of_material_consumptions c
        WHERE ${anchorIsLot ? "c.lot_id" : "c.of_id"} = ANY($1::${anchorIsLot ? "uuid" : "bigint"}[])
          AND c.status <> 'CANCELLED'
          AND ($2::timestamptz IS NULL OR c.effective_at <= $2::timestamptz)
        ORDER BY c.effective_at DESC
        LIMIT ${CAP}`,
      [ids, asOf]
    ))
  );

  // 2) Réservation consommée : preuve par clés étrangères
  out.push(
    ...(await edgesFrom(
      {
        direction,
        relation: "CONSUMED_BY",
        fromType: "lot",
        toType: "of",
        proof: "proven",
        source: "stock_reservations.consumed_stock_movement_id",
      },
      `SELECT r.lot_id::text AS from_id,
              r.of_id::text AS to_id,
              r.qty_reserved::float8 AS qty, NULL::text AS unit,
              COALESCE(r.consumed_at, r.updated_at) AS effective_at,
              r.id::text AS evidence_ref, r.status AS historical_status,
              r.correlation_id::text AS correlation_id
         FROM public.stock_reservations r
        WHERE ${anchorIsLot ? "r.lot_id" : "r.of_id"} = ANY($1::${anchorIsLot ? "uuid" : "bigint"}[])
          AND r.of_id IS NOT NULL
          AND r.lot_id IS NOT NULL
          AND r.status = 'CONSUMED'
          AND r.consumed_stock_movement_id IS NOT NULL
          AND ($2::timestamptz IS NULL OR COALESCE(r.consumed_at, r.updated_at) <= $2::timestamptz)
        ORDER BY COALESCE(r.consumed_at, r.updated_at) DESC
        LIMIT ${CAP}`,
      [ids, asOf]
    ))
  );

  // 3) Sortie comptabilisée déclarant un OF : `declared`, jamais `proven`.
  out.push(
    ...(await edgesFrom(
      {
        direction,
        relation: "CONSUMED_BY",
        fromType: "lot",
        toType: "of",
        proof: "declared",
        source: "stock_movements.source_document_type='OF'",
      },
      `SELECT sl.lot_id::text AS from_id,
              sm.source_document_id AS to_id,
              sl.qty::float8 AS qty, sl.unite AS unit,
              COALESCE(sm.posted_at, sm.effective_at) AS effective_at,
              sl.id::text AS evidence_ref, sm.status AS historical_status,
              sm.correlation_id::text AS correlation_id
         FROM public.stock_movements sm
         JOIN public.stock_movement_lines sl ON sl.movement_id = sm.id
        WHERE sm.status = 'POSTED'
          AND sm.source_document_type = 'OF'
          AND sm.source_document_id ~ '^[0-9]{1,18}$'
          AND sl.lot_id IS NOT NULL
          AND ${anchorIsLot ? "sl.lot_id = ANY($1::uuid[])" : "sm.source_document_id = ANY($1::text[])"}
          AND ($2::timestamptz IS NULL OR COALESCE(sm.posted_at, sm.effective_at) <= $2::timestamptz)
        ORDER BY COALESCE(sm.posted_at, sm.effective_at) DESC
        LIMIT ${CAP}`,
      [ids, asOf]
    ))
  );

  return out;
}

async function lateralEvidenceForLots(ids: string[], asOf: string | null): Promise<NeighborEdge[]> {
  const out: NeighborEdge[] = [];
  out.push(
    ...(await edgesFrom(
      {
        direction: "lateral",
        relation: "CONTROLLED_BY",
        fromType: "lot",
        toType: "quality_control",
        proof: "proven",
        source: "quality_control.lot_id",
      },
      `SELECT qc.lot_id::text AS from_id, qc.id::text AS to_id,
              qc.qty_controlled::float8 AS qty, qc.unite AS unit,
              qc.control_date AS effective_at, qc.id::text AS evidence_ref,
              qc.status::text AS historical_status, qc.correlation_id::text AS correlation_id
         FROM public.quality_control qc
        WHERE qc.lot_id = ANY($1::uuid[])
          AND ($2::timestamptz IS NULL OR qc.control_date <= $2::timestamptz)
        ORDER BY qc.control_date DESC
        LIMIT ${CAP}`,
      [ids, asOf]
    )),
    ...(await edgesFrom(
      {
        direction: "lateral",
        relation: "AFFECTED_BY_NC",
        fromType: "lot",
        toType: "non_conformity",
        proof: "proven",
        source: "non_conformity.lot_id",
      },
      `SELECT nc.lot_id::text AS from_id, nc.id::text AS to_id,
              nc.qty::float8 AS qty, nc.unite AS unit,
              nc.detection_date AS effective_at, nc.id::text AS evidence_ref,
              nc.status::text AS historical_status, nc.correlation_id::text AS correlation_id
         FROM public.non_conformity nc
        WHERE nc.lot_id = ANY($1::uuid[])
          AND ($2::timestamptz IS NULL OR nc.detection_date <= $2::timestamptz)
        ORDER BY nc.detection_date DESC
        LIMIT ${CAP}`,
      [ids, asOf]
    )),
    ...(await edgesFrom(
      {
        direction: "lateral",
        relation: "COVERED_BY_DEROGATION",
        fromType: "lot",
        toType: "derogation",
        proof: "proven",
        source: "quality_derogation.lot_id",
      },
      `SELECT d.lot_id::text AS from_id, d.id::text AS to_id,
              d.max_qty::float8 AS qty, d.unite AS unit,
              d.approved_at AS effective_at, d.id::text AS evidence_ref,
              d.status AS historical_status, d.correlation_id::text AS correlation_id
         FROM public.quality_derogation d
        WHERE d.lot_id = ANY($1::uuid[])
        ORDER BY d.created_at DESC
        LIMIT ${CAP}`,
      [ids]
    )),
    ...(await edgesFrom(
      {
        direction: "lateral",
        relation: "DOCUMENTED_BY",
        fromType: "lot",
        toType: "asbuilt_pack",
        proof: "proven",
        source: "asbuilt_pack_versions.lot_fg_id",
      },
      `SELECT p.lot_fg_id::text AS from_id, p.id::text AS to_id,
              NULL::float8 AS qty, NULL::text AS unit,
              p.generated_at AS effective_at, p.id::text AS evidence_ref,
              p.status AS historical_status
         FROM public.asbuilt_pack_versions p
        WHERE p.lot_fg_id = ANY($1::uuid[])
          AND ($2::timestamptz IS NULL OR p.generated_at <= $2::timestamptz)
        ORDER BY p.version DESC
        LIMIT ${CAP}`,
      [ids, asOf]
    ))
  );
  return out;
}

/* -------------------------------- OF -------------------------------------- */

const expandOf: Expander = async (rawIds, direction, ctx) => {
  const ids = bigints(rawIds);
  if (!ids.length) return [];
  const asOf = ctx.asOf;
  const out: NeighborEdge[] = [];

  if (direction === "upstream") {
    out.push(
      ...(await consumptionEdges(ids, "byOf", asOf)),
      // OF parent : arborescence récursive (#170).
      ...(await edgesFrom(
        {
          direction: "upstream",
          relation: "CHILD_OF",
          fromType: "of",
          toType: "of",
          proof: "proven",
          source: "ordres_fabrication.parent_of_id",
        },
        `SELECT o.parent_of_id::text AS from_id, o.id::text AS to_id,
                o.quantity_per_parent::float8 AS qty, NULL::text AS unit,
                o.created_at AS effective_at, o.id::text AS evidence_ref,
                o.statut::text AS historical_status
           FROM public.ordres_fabrication o
          WHERE o.id = ANY($1::bigint[]) AND o.parent_of_id IS NOT NULL
          LIMIT ${CAP}`,
        [ids]
      )),
      // Version technique FIGÉE sur l'OF (pas la version courante de la pièce).
      ...(await edgesFrom(
        {
          direction: "upstream",
          relation: "USES_VERSION",
          fromType: "piece_version",
          toType: "of",
          proof: "proven",
          source: "of_technical_snapshots.piece_technique_version_id",
        },
        `SELECT s.piece_technique_version_id::text AS from_id, s.of_id::text AS to_id,
                NULL::float8 AS qty, NULL::text AS unit,
                s.created_at AS effective_at, s.snapshot_sha256 AS evidence_ref,
                NULL::text AS historical_status
           FROM public.of_technical_snapshots s
          WHERE s.of_id = ANY($1::bigint[])
          LIMIT ${CAP}`,
        [ids]
      )),
      ...(await edgesFrom(
        {
          direction: "upstream",
          relation: "BELONGS_TO_AFFAIRE",
          fromType: "affaire",
          toType: "of",
          proof: "proven",
          source: "ordres_fabrication.affaire_id",
        },
        `SELECT o.affaire_id::text AS from_id, o.id::text AS to_id,
                NULL::float8 AS qty, NULL::text AS unit,
                o.created_at AS effective_at, o.id::text AS evidence_ref,
                o.statut::text AS historical_status
           FROM public.ordres_fabrication o
          WHERE o.id = ANY($1::bigint[]) AND o.affaire_id IS NOT NULL
          LIMIT ${CAP}`,
        [ids]
      )),
      ...(await edgesFrom(
        {
          direction: "upstream",
          relation: "ORDER_LINE_OF",
          fromType: "commande",
          toType: "of",
          proof: "proven",
          source: "ordres_fabrication.commande_id",
        },
        `SELECT o.commande_id::text AS from_id, o.id::text AS to_id,
                o.quantite_lancee::float8 AS qty, NULL::text AS unit,
                o.created_at AS effective_at, o.id::text AS evidence_ref,
                o.statut::text AS historical_status
           FROM public.ordres_fabrication o
          WHERE o.id = ANY($1::bigint[]) AND o.commande_id IS NOT NULL
          LIMIT ${CAP}`,
        [ids]
      ))
    );
  } else {
    out.push(
      // Lots fabriqués.
      ...(await edgesFrom(
        {
          direction: "downstream",
          relation: "PRODUCED_BY",
          fromType: "of",
          toType: "lot",
          proof: "proven",
          source: "of_output_lots.of_id",
        },
        `SELECT ool.of_id::text AS from_id, ool.lot_id::text AS to_id,
                ool.qty_ok::float8 AS qty, NULL::text AS unit,
                ool.created_at AS effective_at, ool.id::text AS evidence_ref,
                NULL::text AS historical_status
           FROM public.of_output_lots ool
          WHERE ool.of_id = ANY($1::bigint[])
            AND ($2::timestamptz IS NULL OR ool.created_at <= $2::timestamptz)
          ORDER BY ool.created_at DESC
          LIMIT ${CAP}`,
        [ids, asOf]
      )),
      // Réceptions de production.
      ...(await edgesFrom(
        {
          direction: "downstream",
          relation: "ISSUED_FROM",
          fromType: "of",
          toType: "of_receipt",
          proof: "proven",
          source: "of_receipts.of_id",
        },
        `SELECT rc.of_id::text AS from_id, rc.id::text AS to_id,
                rc.qty_ok::float8 AS qty, NULL::text AS unit,
                rc.created_at AS effective_at, rc.id::text AS evidence_ref,
                rc.quality_status AS historical_status
           FROM public.of_receipts rc
          WHERE rc.of_id = ANY($1::bigint[])
            AND ($2::timestamptz IS NULL OR rc.created_at <= $2::timestamptz)
          ORDER BY rc.created_at DESC
          LIMIT ${CAP}`,
        [ids, asOf]
      )),
      // OF enfants.
      ...(await edgesFrom(
        {
          direction: "downstream",
          relation: "CHILD_OF",
          fromType: "of",
          toType: "of",
          proof: "proven",
          source: "ordres_fabrication.parent_of_id",
        },
        `SELECT o.parent_of_id::text AS from_id, o.id::text AS to_id,
                o.quantity_per_parent::float8 AS qty, NULL::text AS unit,
                o.created_at AS effective_at, o.id::text AS evidence_ref,
                o.statut::text AS historical_status
           FROM public.ordres_fabrication o
          WHERE o.parent_of_id = ANY($1::bigint[])
          ORDER BY o.id ASC
          LIMIT ${CAP}`,
        [ids]
      )),
      // Opérations de gamme instanciées.
      ...(await edgesFrom(
        {
          direction: "downstream",
          relation: "OF_OPERATION_OF",
          fromType: "of",
          toType: "of_operation",
          proof: "proven",
          source: "of_operations.of_id",
        },
        `SELECT op.of_id::text AS from_id, op.id::text AS to_id,
                op.qte::float8 AS qty, NULL::text AS unit,
                COALESCE(op.started_at, op.created_at) AS effective_at,
                op.id::text AS evidence_ref, op.status::text AS historical_status
           FROM public.of_operations op
          WHERE op.of_id = ANY($1::bigint[])
          ORDER BY op.phase ASC
          LIMIT ${CAP}`,
        [ids]
      ))
    );
  }

  if (direction === ctx.lateralOn) {
    out.push(
      ...(await edgesFrom(
        {
          direction: "lateral",
          relation: "CONTROLLED_BY",
          fromType: "of",
          toType: "quality_control",
          proof: "proven",
          source: "quality_control.of_id",
        },
        `SELECT qc.of_id::text AS from_id, qc.id::text AS to_id,
                qc.qty_controlled::float8 AS qty, qc.unite AS unit,
                qc.control_date AS effective_at, qc.id::text AS evidence_ref,
                qc.status::text AS historical_status
           FROM public.quality_control qc
          WHERE qc.of_id = ANY($1::bigint[])
            AND ($2::timestamptz IS NULL OR qc.control_date <= $2::timestamptz)
          ORDER BY qc.control_date DESC
          LIMIT ${CAP}`,
        [ids, asOf]
      )),
      ...(await edgesFrom(
        {
          direction: "lateral",
          relation: "AFFECTED_BY_NC",
          fromType: "of",
          toType: "non_conformity",
          proof: "proven",
          source: "non_conformity.of_id",
        },
        `SELECT nc.of_id::text AS from_id, nc.id::text AS to_id,
                nc.qty::float8 AS qty, nc.unite AS unit,
                nc.detection_date AS effective_at, nc.id::text AS evidence_ref,
                nc.status::text AS historical_status
           FROM public.non_conformity nc
          WHERE nc.of_id = ANY($1::bigint[])
            AND ($2::timestamptz IS NULL OR nc.detection_date <= $2::timestamptz)
          ORDER BY nc.detection_date DESC
          LIMIT ${CAP}`,
        [ids, asOf]
      )),
      ...(await edgesFrom(
        {
          direction: "lateral",
          relation: "COVERED_BY_DEROGATION",
          fromType: "of",
          toType: "derogation",
          proof: "proven",
          source: "quality_derogation.of_id",
        },
        `SELECT d.of_id::text AS from_id, d.id::text AS to_id,
                d.max_qty::float8 AS qty, d.unite AS unit,
                d.approved_at AS effective_at, d.id::text AS evidence_ref,
                d.status AS historical_status
           FROM public.quality_derogation d
          WHERE d.of_id = ANY($1::bigint[])
          ORDER BY d.created_at DESC
          LIMIT ${CAP}`,
        [ids]
      ))
    );
  }

  return out;
};

/* --------------------------- OF OPERATION --------------------------------- */

const expandOfOperation: Expander = async (rawIds, direction, ctx) => {
  const ids = uuids(rawIds);
  if (!ids.length) return [];
  const out: NeighborEdge[] = [];

  if (direction === "upstream") {
    out.push(
      ...(await edgesFrom(
        {
          direction: "upstream",
          relation: "OF_OPERATION_OF",
          fromType: "of",
          toType: "of_operation",
          proof: "proven",
          source: "of_operations.of_id",
        },
        `SELECT op.of_id::text AS from_id, op.id::text AS to_id,
                op.qte::float8 AS qty, NULL::text AS unit,
                COALESCE(op.started_at, op.created_at) AS effective_at,
                op.id::text AS evidence_ref, op.status::text AS historical_status
           FROM public.of_operations op
          WHERE op.id = ANY($1::uuid[])
          LIMIT ${CAP}`,
        [ids]
      ))
    );
  } else {
    out.push(
      // Machine réellement affectée à l'opération.
      ...(await edgesFrom(
        {
          direction: "downstream",
          relation: "EXECUTED_ON",
          fromType: "of_operation",
          toType: "machine",
          proof: "proven",
          source: "of_operations.machine_id",
        },
        `SELECT op.id::text AS from_id, op.machine_id::text AS to_id,
                NULL::float8 AS qty, NULL::text AS unit,
                COALESCE(op.started_at, op.created_at) AS effective_at,
                op.id::text AS evidence_ref, op.status::text AS historical_status
           FROM public.of_operations op
          WHERE op.id = ANY($1::uuid[]) AND op.machine_id IS NOT NULL
          LIMIT ${CAP}`,
        [ids]
      )),
      ...(await edgesFrom(
        {
          direction: "downstream",
          relation: "EXECUTED_ON",
          fromType: "of_operation",
          toType: "poste",
          proof: "proven",
          source: "of_operations.poste_id",
        },
        `SELECT op.id::text AS from_id, op.poste_id::text AS to_id,
                NULL::float8 AS qty, NULL::text AS unit,
                COALESCE(op.started_at, op.created_at) AS effective_at,
                op.id::text AS evidence_ref, op.status::text AS historical_status
           FROM public.of_operations op
          WHERE op.id = ANY($1::uuid[]) AND op.poste_id IS NOT NULL
          LIMIT ${CAP}`,
        [ids]
      )),
      // Pointages rattachés à l'opération.
      ...(await edgesFrom(
        {
          direction: "downstream",
          relation: "CLOCKED_IN",
          fromType: "of_operation",
          toType: "pointage",
          proof: "proven",
          source: "production_pointages.operation_id",
        },
        `SELECT p.operation_id::text AS from_id, p.id::text AS to_id,
                p.duration_minutes::float8 AS qty, 'min'::text AS unit,
                p.start_ts AS effective_at, p.id::text AS evidence_ref,
                p.status::text AS historical_status
           FROM public.production_pointages p
          WHERE p.operation_id = ANY($1::uuid[])
            AND p.status <> 'CANCELLED'
            AND ($2::timestamptz IS NULL OR p.start_ts <= $2::timestamptz)
          ORDER BY p.start_ts DESC
          LIMIT ${CAP}`,
        [ids, ctx.asOf]
      ))
    );
  }

  if (direction === ctx.lateralOn) {
    out.push(
      ...(await edgesFrom(
        {
          direction: "lateral",
          relation: "CONTROLLED_BY",
          fromType: "of_operation",
          toType: "quality_control",
          proof: "proven",
          source: "quality_control.operation_id",
        },
        `SELECT qc.operation_id::text AS from_id, qc.id::text AS to_id,
                qc.qty_controlled::float8 AS qty, qc.unite AS unit,
                qc.control_date AS effective_at, qc.id::text AS evidence_ref,
                qc.status::text AS historical_status
           FROM public.quality_control qc
          WHERE qc.operation_id = ANY($1::uuid[])
          ORDER BY qc.control_date DESC
          LIMIT ${CAP}`,
        [ids]
      )),
      ...(await edgesFrom(
        {
          direction: "lateral",
          relation: "AFFECTED_BY_NC",
          fromType: "of_operation",
          toType: "non_conformity",
          proof: "proven",
          source: "non_conformity.of_operation_id",
        },
        `SELECT nc.of_operation_id::text AS from_id, nc.id::text AS to_id,
                nc.qty::float8 AS qty, nc.unite AS unit,
                nc.detection_date AS effective_at, nc.id::text AS evidence_ref,
                nc.status::text AS historical_status
           FROM public.non_conformity nc
          WHERE nc.of_operation_id = ANY($1::uuid[])
          ORDER BY nc.detection_date DESC
          LIMIT ${CAP}`,
        [ids]
      ))
    );
  }

  return out;
};

/* ------------------------------ POINTAGE ---------------------------------- */

const expandPointage: Expander = async (rawIds, direction) => {
  const ids = uuids(rawIds);
  if (!ids.length || direction !== "downstream") return [];
  // La machine réellement utilisée pour CE pointage peut différer de celle
  // planifiée sur l'opération : c'est le pointage qui fait foi.
  return edgesFrom(
    {
      direction: "downstream",
      relation: "EXECUTED_ON",
      fromType: "pointage",
      toType: "machine",
      proof: "proven",
      source: "production_pointages.machine_id",
    },
    `SELECT p.id::text AS from_id, p.machine_id::text AS to_id,
            p.duration_minutes::float8 AS qty, 'min'::text AS unit,
            p.start_ts AS effective_at, p.id::text AS evidence_ref,
            p.status::text AS historical_status
       FROM public.production_pointages p
      WHERE p.id = ANY($1::uuid[]) AND p.machine_id IS NOT NULL
      LIMIT ${CAP}`,
    [ids]
  );
};

/* ---------------------------- OF RECEIPT ---------------------------------- */

const expandOfReceipt: Expander = async (rawIds, direction) => {
  const ids = uuids(rawIds);
  if (!ids.length) return [];

  if (direction === "downstream") {
    return [
      ...(await edgesFrom(
        {
          direction: "downstream",
          relation: "MOVED_BY",
          fromType: "of_receipt",
          toType: "stock_movement",
          proof: "proven",
          source: "of_receipts.stock_movement_id",
        },
        `SELECT rc.id::text AS from_id, rc.stock_movement_id::text AS to_id,
                rc.qty_ok::float8 AS qty, NULL::text AS unit,
                rc.created_at AS effective_at, rc.id::text AS evidence_ref,
                rc.quality_status AS historical_status
           FROM public.of_receipts rc
          WHERE rc.id = ANY($1::uuid[])
          LIMIT ${CAP}`,
        [ids]
      )),
      ...(await edgesFrom(
        {
          direction: "downstream",
          relation: "CREATED_LOT",
          fromType: "of_receipt",
          toType: "lot",
          proof: "proven",
          source: "of_receipts.lot_id",
        },
        `SELECT rc.id::text AS from_id, rc.lot_id::text AS to_id,
                rc.qty_ok::float8 AS qty, NULL::text AS unit,
                rc.created_at AS effective_at, rc.id::text AS evidence_ref,
                rc.quality_status AS historical_status
           FROM public.of_receipts rc
          WHERE rc.id = ANY($1::uuid[])
          LIMIT ${CAP}`,
        [ids]
      )),
    ];
  }

  return edgesFrom(
    {
      direction: "upstream",
      relation: "ISSUED_FROM",
      fromType: "of",
      toType: "of_receipt",
      proof: "proven",
      source: "of_receipts.of_id",
    },
    `SELECT rc.of_id::text AS from_id, rc.id::text AS to_id,
            rc.qty_ok::float8 AS qty, NULL::text AS unit,
            rc.created_at AS effective_at, rc.id::text AS evidence_ref,
            rc.quality_status AS historical_status
       FROM public.of_receipts rc
      WHERE rc.id = ANY($1::uuid[])
      LIMIT ${CAP}`,
    [ids]
  );
};

/* --------------------------- STOCK MOVEMENT -------------------------------- */

const expandStockMovement: Expander = async (rawIds, direction) => {
  const ids = uuids(rawIds);
  if (!ids.length) return [];

  if (direction === "upstream") {
    return [
      // Un mouvement compensatoire pointe explicitement le mouvement qu'il annule.
      ...(await edgesFrom(
        {
          direction: "upstream",
          relation: "COMPENSATES",
          fromType: "stock_movement",
          toType: "stock_movement",
          proof: "proven",
          source: "stock_movements.reversal_of_id",
        },
        `SELECT sm.reversal_of_id::text AS from_id, sm.id::text AS to_id,
                NULL::float8 AS qty, NULL::text AS unit,
                COALESCE(sm.posted_at, sm.effective_at) AS effective_at,
                sm.id::text AS evidence_ref, sm.status AS historical_status,
                sm.correlation_id::text AS correlation_id
           FROM public.stock_movements sm
          WHERE sm.id = ANY($1::uuid[]) AND sm.reversal_of_id IS NOT NULL
          LIMIT ${CAP}`,
        [ids]
      )),
      // Origine réception fournisseur (FK explicite, pas une référence texte).
      ...(await edgesFrom(
        {
          direction: "upstream",
          relation: "RECEIVED_IN",
          fromType: "reception_ligne",
          toType: "stock_movement",
          proof: "proven",
          source: "reception_fournisseur_stock_receipts.stock_movement_id",
        },
        `SELECT sr.reception_line_id::text AS from_id, sr.stock_movement_id::text AS to_id,
                sr.qty::float8 AS qty, NULL::text AS unit,
                sr.created_at AS effective_at, sr.id::text AS evidence_ref,
                NULL::text AS historical_status
           FROM public.reception_fournisseur_stock_receipts sr
          WHERE sr.stock_movement_id = ANY($1::uuid[])
          LIMIT ${CAP}`,
        [ids]
      )),
    ];
  }

  return [
    ...(await edgesFrom(
      {
        direction: "downstream",
        relation: "COMPENSATES",
        fromType: "stock_movement",
        toType: "stock_movement",
        proof: "proven",
        source: "stock_movements.reversal_of_id",
      },
      `SELECT sm.reversal_of_id::text AS from_id, sm.id::text AS to_id,
              NULL::float8 AS qty, NULL::text AS unit,
              COALESCE(sm.posted_at, sm.effective_at) AS effective_at,
              sm.id::text AS evidence_ref, sm.status AS historical_status
         FROM public.stock_movements sm
        WHERE sm.reversal_of_id = ANY($1::uuid[])
        LIMIT ${CAP}`,
      [ids]
    )),
    ...(await edgesFrom(
      {
        direction: "downstream",
        relation: "MOVED_BY",
        fromType: "stock_movement",
        toType: "lot",
        proof: "proven",
        source: "stock_movement_lines.lot_id",
      },
      `SELECT sl.movement_id::text AS from_id, sl.lot_id::text AS to_id,
              sl.qty::float8 AS qty, sl.unite AS unit,
              sl.created_at AS effective_at, sl.id::text AS evidence_ref,
              NULL::text AS historical_status
         FROM public.stock_movement_lines sl
        WHERE sl.movement_id = ANY($1::uuid[]) AND sl.lot_id IS NOT NULL
        LIMIT ${CAP}`,
      [ids]
    )),
  ];
};

/* ---------------------------- RESERVATION --------------------------------- */

const expandReservation: Expander = async (rawIds, direction) => {
  const ids = uuids(rawIds);
  if (!ids.length || direction !== "downstream") return [];

  return [
    ...(await edgesFrom(
      {
        direction: "downstream",
        relation: "RESERVED_FOR",
        fromType: "reservation",
        toType: "of",
        proof: "proven",
        source: "stock_reservations.of_id",
      },
      `SELECT r.id::text AS from_id, r.of_id::text AS to_id,
              r.qty_reserved::float8 AS qty, NULL::text AS unit,
              r.created_at AS effective_at, r.id::text AS evidence_ref,
              r.status AS historical_status
         FROM public.stock_reservations r
        WHERE r.id = ANY($1::uuid[]) AND r.of_id IS NOT NULL
        LIMIT ${CAP}`,
      [ids]
    )),
    ...(await edgesFrom(
      {
        direction: "downstream",
        relation: "RESERVED_FOR",
        fromType: "reservation",
        toType: "bon_livraison_ligne",
        proof: "proven",
        source: "stock_reservations.bon_livraison_ligne_id",
      },
      `SELECT r.id::text AS from_id, r.bon_livraison_ligne_id::text AS to_id,
              r.qty_reserved::float8 AS qty, NULL::text AS unit,
              r.created_at AS effective_at, r.id::text AS evidence_ref,
              r.status AS historical_status
         FROM public.stock_reservations r
        WHERE r.id = ANY($1::uuid[]) AND r.bon_livraison_ligne_id IS NOT NULL
        LIMIT ${CAP}`,
      [ids]
    )),
    ...(await edgesFrom(
      {
        direction: "downstream",
        relation: "MOVED_BY",
        fromType: "reservation",
        toType: "stock_movement",
        proof: "proven",
        source: "stock_reservations.consumed_stock_movement_id",
      },
      `SELECT r.id::text AS from_id, r.consumed_stock_movement_id::text AS to_id,
              r.qty_reserved::float8 AS qty, NULL::text AS unit,
              r.consumed_at AS effective_at, r.id::text AS evidence_ref,
              r.status AS historical_status
         FROM public.stock_reservations r
        WHERE r.id = ANY($1::uuid[]) AND r.consumed_stock_movement_id IS NOT NULL
        LIMIT ${CAP}`,
      [ids]
    )),
  ];
};

/* --------------------------- RECEPTION CHAIN ------------------------------- */

const expandReceptionLigne: Expander = async (rawIds, direction, ctx) => {
  const ids = uuids(rawIds);
  if (!ids.length) return [];

  if (direction === "upstream") {
    return [
      ...(await edgesFrom(
        {
          direction: "upstream",
          relation: "RECEPTION_LINE_OF",
          fromType: "reception_fournisseur",
          toType: "reception_ligne",
          proof: "proven",
          source: "reception_fournisseur_lignes.reception_id",
        },
        `SELECT rl.reception_id::text AS from_id, rl.id::text AS to_id,
                rl.qty_received::float8 AS qty, rl.unite AS unit,
                rl.created_at AS effective_at, rl.id::text AS evidence_ref,
                NULL::text AS historical_status
           FROM public.reception_fournisseur_lignes rl
          WHERE rl.id = ANY($1::uuid[])
          LIMIT ${CAP}`,
        [ids]
      )),
      ...(await edgesFrom(
        {
          direction: "upstream",
          relation: "ORDERED_FROM",
          fromType: "commande_fournisseur",
          toType: "reception_ligne",
          proof: "proven",
          source: "commande_fournisseur_ligne.commande_id",
        },
        `SELECT cfl.commande_id::text AS from_id, rl.id::text AS to_id,
                rl.qty_received::float8 AS qty, rl.unite AS unit,
                rl.created_at AS effective_at, rl.id::text AS evidence_ref,
                cfl.statut_ligne AS historical_status
           FROM public.reception_fournisseur_lignes rl
           JOIN public.commande_fournisseur_ligne cfl ON cfl.id = rl.commande_fournisseur_ligne_id
          WHERE rl.id = ANY($1::uuid[])
          LIMIT ${CAP}`,
        [ids]
      )),
      ...(await edgesFrom(
        {
          direction: "upstream",
          relation: "ARTICLE_OF",
          fromType: "article",
          toType: "reception_ligne",
          proof: "proven",
          source: "reception_fournisseur_lignes.article_id",
        },
        `SELECT rl.article_id::text AS from_id, rl.id::text AS to_id,
                rl.qty_received::float8 AS qty, rl.unite AS unit,
                rl.created_at AS effective_at, rl.id::text AS evidence_ref,
                NULL::text AS historical_status
           FROM public.reception_fournisseur_lignes rl
          WHERE rl.id = ANY($1::uuid[])
          LIMIT ${CAP}`,
        [ids]
      )),
    ];
  }

  const out: NeighborEdge[] = [
    ...(await edgesFrom(
      {
        direction: "downstream",
        relation: "CREATED_LOT",
        fromType: "reception_ligne",
        toType: "lot",
        proof: "proven",
        source: "reception_fournisseur_lignes.lot_id",
      },
      `SELECT rl.id::text AS from_id, rl.lot_id::text AS to_id,
              rl.qty_received::float8 AS qty, rl.unite AS unit,
              rl.created_at AS effective_at, rl.id::text AS evidence_ref,
              NULL::text AS historical_status
         FROM public.reception_fournisseur_lignes rl
        WHERE rl.id = ANY($1::uuid[]) AND rl.lot_id IS NOT NULL
        LIMIT ${CAP}`,
      [ids]
    )),
    ...(await edgesFrom(
      {
        direction: "downstream",
        relation: "RECEIVED_IN",
        fromType: "reception_ligne",
        toType: "stock_movement",
        proof: "proven",
        source: "reception_fournisseur_stock_receipts.reception_line_id",
      },
      `SELECT sr.reception_line_id::text AS from_id, sr.stock_movement_id::text AS to_id,
              sr.qty::float8 AS qty, NULL::text AS unit,
              sr.created_at AS effective_at, sr.id::text AS evidence_ref,
              NULL::text AS historical_status
         FROM public.reception_fournisseur_stock_receipts sr
        WHERE sr.reception_line_id = ANY($1::uuid[])
        LIMIT ${CAP}`,
      [ids]
    )),
  ];

  if (direction === ctx.lateralOn) {
    out.push(
      ...(await edgesFrom(
        {
          direction: "lateral",
          relation: "INSPECTED_BY",
          fromType: "reception_ligne",
          toType: "reception_inspection",
          proof: "proven",
          source: "reception_incoming_inspections.reception_line_id",
        },
        `SELECT i.reception_line_id::text AS from_id, i.id::text AS to_id,
                NULL::float8 AS qty, NULL::text AS unit,
                COALESCE(i.decided_at, i.started_at) AS effective_at,
                i.id::text AS evidence_ref, i.status AS historical_status
           FROM public.reception_incoming_inspections i
          WHERE i.reception_line_id = ANY($1::uuid[])
          LIMIT ${CAP}`,
        [ids]
      ))
    );
  }

  return out;
};

const expandReceptionFournisseur: Expander = async (rawIds, direction) => {
  const ids = uuids(rawIds);
  if (!ids.length) return [];

  if (direction === "upstream") {
    return [
      ...(await edgesFrom(
        {
          direction: "upstream",
          relation: "ORDERED_FROM",
          fromType: "fournisseur",
          toType: "reception_fournisseur",
          proof: "proven",
          source: "receptions_fournisseurs.fournisseur_id",
        },
        `SELECT r.fournisseur_id::text AS from_id, r.id::text AS to_id,
                NULL::float8 AS qty, NULL::text AS unit,
                r.reception_date::text AS effective_at, r.id::text AS evidence_ref,
                r.status AS historical_status
           FROM public.receptions_fournisseurs r
          WHERE r.id = ANY($1::uuid[])
          LIMIT ${CAP}`,
        [ids]
      )),
      ...(await edgesFrom(
        {
          direction: "upstream",
          relation: "RECEIVED_IN",
          fromType: "commande_fournisseur",
          toType: "reception_fournisseur",
          proof: "proven",
          source: "receptions_fournisseurs.commande_fournisseur_id",
        },
        `SELECT r.commande_fournisseur_id::text AS from_id, r.id::text AS to_id,
                NULL::float8 AS qty, NULL::text AS unit,
                r.reception_date::text AS effective_at, r.id::text AS evidence_ref,
                r.status AS historical_status
           FROM public.receptions_fournisseurs r
          WHERE r.id = ANY($1::uuid[]) AND r.commande_fournisseur_id IS NOT NULL
          LIMIT ${CAP}`,
        [ids]
      )),
    ];
  }

  return edgesFrom(
    {
      direction: "downstream",
      relation: "RECEPTION_LINE_OF",
      fromType: "reception_fournisseur",
      toType: "reception_ligne",
      proof: "proven",
      source: "reception_fournisseur_lignes.reception_id",
    },
    `SELECT rl.reception_id::text AS from_id, rl.id::text AS to_id,
            rl.qty_received::float8 AS qty, rl.unite AS unit,
            rl.created_at AS effective_at, rl.id::text AS evidence_ref,
            NULL::text AS historical_status
       FROM public.reception_fournisseur_lignes rl
      WHERE rl.reception_id = ANY($1::uuid[])
      ORDER BY rl.line_no ASC
      LIMIT ${CAP}`,
    [ids]
  );
};

const expandReceptionInspection: Expander = async (rawIds, direction) => {
  const ids = uuids(rawIds);
  if (!ids.length || direction !== "downstream") return [];
  return edgesFrom(
    {
      direction: "downstream",
      relation: "MEASURED_IN",
      fromType: "reception_inspection",
      toType: "quality_measurement",
      proof: "proven",
      source: "reception_incoming_measurements.inspection_id",
    },
    `SELECT m.inspection_id::text AS from_id, m.id::text AS to_id,
            m.measured_value::float8 AS qty, m.unit AS unit,
            m.created_at AS effective_at, m.id::text AS evidence_ref,
            m.result AS historical_status
       FROM public.reception_incoming_measurements m
      WHERE m.inspection_id = ANY($1::uuid[])
      LIMIT ${CAP}`,
    [ids]
  );
};

const expandCommandeFournisseur: Expander = async (rawIds, direction) => {
  const ids = uuids(rawIds);
  if (!ids.length) return [];

  if (direction === "upstream") {
    return edgesFrom(
      {
        direction: "upstream",
        relation: "ORDERED_FROM",
        fromType: "fournisseur",
        toType: "commande_fournisseur",
        proof: "proven",
        source: "commande_fournisseur.fournisseur_id",
      },
      `SELECT cf.fournisseur_id::text AS from_id, cf.id::text AS to_id,
              cf.total_ht::float8 AS qty, cf.devise AS unit,
              cf.created_at AS effective_at, cf.id::text AS evidence_ref,
              cf.statut AS historical_status
         FROM public.commande_fournisseur cf
        WHERE cf.id = ANY($1::uuid[])
        LIMIT ${CAP}`,
      [ids]
    );
  }

  return edgesFrom(
    {
      direction: "downstream",
      relation: "RECEIVED_IN",
      fromType: "commande_fournisseur",
      toType: "reception_fournisseur",
      proof: "proven",
      source: "receptions_fournisseurs.commande_fournisseur_id",
    },
    `SELECT r.commande_fournisseur_id::text AS from_id, r.id::text AS to_id,
            NULL::float8 AS qty, NULL::text AS unit,
            r.reception_date::text AS effective_at, r.id::text AS evidence_ref,
            r.status AS historical_status
       FROM public.receptions_fournisseurs r
      WHERE r.commande_fournisseur_id = ANY($1::uuid[])
      ORDER BY r.reception_date DESC
      LIMIT ${CAP}`,
    [ids]
  );
};

const expandFournisseur: Expander = async (rawIds, direction) => {
  const ids = uuids(rawIds);
  if (!ids.length || direction !== "downstream") return [];
  return edgesFrom(
    {
      direction: "downstream",
      relation: "ORDERED_FROM",
      fromType: "fournisseur",
      toType: "commande_fournisseur",
      proof: "proven",
      source: "commande_fournisseur.fournisseur_id",
    },
    `SELECT cf.fournisseur_id::text AS from_id, cf.id::text AS to_id,
            cf.total_ht::float8 AS qty, cf.devise AS unit,
            cf.created_at AS effective_at, cf.id::text AS evidence_ref,
            cf.statut AS historical_status
       FROM public.commande_fournisseur cf
      WHERE cf.fournisseur_id = ANY($1::uuid[])
      ORDER BY cf.created_at DESC
      LIMIT ${CAP}`,
    [ids]
  );
};

/* ------------------------- QUALITÉ / MÉTROLOGIE ---------------------------- */

const expandQualityControl: Expander = async (rawIds, direction) => {
  const ids = uuids(rawIds);
  if (!ids.length) return [];

  if (direction === "downstream") {
    return [
      ...(await edgesFrom(
        {
          direction: "downstream",
          relation: "MEASURED_IN",
          fromType: "quality_control",
          toType: "quality_measurement",
          proof: "proven",
          source: "quality_control_points.quality_control_id",
        },
        `SELECT p.quality_control_id::text AS from_id, p.id::text AS to_id,
                p.measured_value::float8 AS qty, p.unit AS unit,
                COALESCE(p.measured_at, p.created_at) AS effective_at,
                p.id::text AS evidence_ref, p.result::text AS historical_status
           FROM public.quality_control_points p
          WHERE p.quality_control_id = ANY($1::uuid[])
          ORDER BY p.created_at ASC
          LIMIT ${CAP}`,
        [ids]
      )),
      ...(await edgesFrom(
        {
          direction: "downstream",
          relation: "RELEASED_BY",
          fromType: "quality_control",
          toType: "release_decision",
          proof: "proven",
          source: "quality_release_decision.quality_control_id",
        },
        `SELECT d.quality_control_id::text AS from_id, d.id::text AS to_id,
                d.qty::float8 AS qty, d.unite AS unit,
                d.decided_at AS effective_at, d.id::text AS evidence_ref,
                d.decision AS historical_status, d.correlation_id::text AS correlation_id
           FROM public.quality_release_decision d
          WHERE d.quality_control_id = ANY($1::uuid[])
          ORDER BY d.decided_at DESC
          LIMIT ${CAP}`,
        [ids]
      )),
      ...(await edgesFrom(
        {
          direction: "downstream",
          relation: "AFFECTED_BY_NC",
          fromType: "quality_control",
          toType: "non_conformity",
          proof: "proven",
          source: "non_conformity.control_id",
        },
        `SELECT nc.control_id::text AS from_id, nc.id::text AS to_id,
                nc.qty::float8 AS qty, nc.unite AS unit,
                nc.detection_date AS effective_at, nc.id::text AS evidence_ref,
                nc.status::text AS historical_status
           FROM public.non_conformity nc
          WHERE nc.control_id = ANY($1::uuid[])
          LIMIT ${CAP}`,
        [ids]
      )),
    ];
  }

  return [
    ...(await edgesFrom(
      {
        direction: "upstream",
        relation: "CONTROLLED_BY",
        fromType: "lot",
        toType: "quality_control",
        proof: "proven",
        source: "quality_control.lot_id",
      },
      `SELECT qc.lot_id::text AS from_id, qc.id::text AS to_id,
              qc.qty_controlled::float8 AS qty, qc.unite AS unit,
              qc.control_date AS effective_at, qc.id::text AS evidence_ref,
              qc.status::text AS historical_status
         FROM public.quality_control qc
        WHERE qc.id = ANY($1::uuid[]) AND qc.lot_id IS NOT NULL
        LIMIT ${CAP}`,
      [ids]
    )),
    ...(await edgesFrom(
      {
        direction: "upstream",
        relation: "CONTROLLED_BY",
        fromType: "of",
        toType: "quality_control",
        proof: "proven",
        source: "quality_control.of_id",
      },
      `SELECT qc.of_id::text AS from_id, qc.id::text AS to_id,
              qc.qty_controlled::float8 AS qty, qc.unite AS unit,
              qc.control_date AS effective_at, qc.id::text AS evidence_ref,
              qc.status::text AS historical_status
         FROM public.quality_control qc
        WHERE qc.id = ANY($1::uuid[]) AND qc.of_id IS NOT NULL
        LIMIT ${CAP}`,
      [ids]
    )),
  ];
};

const expandQualityMeasurement: Expander = async (rawIds, direction) => {
  const ids = uuids(rawIds);
  if (!ids.length || direction !== "downstream") return [];
  // L'instrument est la preuve métrologique de la mesure : sans lui, la mesure
  // n'est pas opposable. On expose le lien, jamais le chemin du certificat.
  return edgesFrom(
    {
      direction: "downstream",
      relation: "MEASURED_WITH",
      fromType: "quality_measurement",
      toType: "metrology_equipment",
      proof: "proven",
      source: "quality_control_points.instrument_id",
    },
    `SELECT p.id::text AS from_id, p.instrument_id::text AS to_id,
            p.measured_value::float8 AS qty, p.unit AS unit,
            COALESCE(p.measured_at, p.created_at) AS effective_at,
            p.id::text AS evidence_ref, p.result::text AS historical_status
       FROM public.quality_control_points p
      WHERE p.id = ANY($1::uuid[]) AND p.instrument_id IS NOT NULL
      LIMIT ${CAP}`,
    [ids]
  );
};

const expandMetrologyEquipment: Expander = async (rawIds, direction, ctx) => {
  const ids = uuids(rawIds);
  if (!ids.length) return [];
  const out: NeighborEdge[] = [];

  if (direction === "downstream") {
    out.push(
      ...(await edgesFrom(
        {
          direction: "downstream",
          relation: "MEASURED_WITH",
          fromType: "metrology_equipment",
          toType: "quality_measurement",
          proof: "proven",
          source: "quality_control_points.instrument_id",
        },
        `SELECT p.instrument_id::text AS from_id, p.id::text AS to_id,
                p.measured_value::float8 AS qty, p.unit AS unit,
                COALESCE(p.measured_at, p.created_at) AS effective_at,
                p.id::text AS evidence_ref, p.result::text AS historical_status
           FROM public.quality_control_points p
          WHERE p.instrument_id = ANY($1::uuid[])
            AND ($2::timestamptz IS NULL OR COALESCE(p.measured_at, p.created_at) <= $2::timestamptz)
          ORDER BY COALESCE(p.measured_at, p.created_at) DESC
          LIMIT ${CAP}`,
        [ids, ctx.asOf]
      ))
    );
  }

  if (direction === ctx.lateralOn) {
    out.push(
      ...(await edgesFrom(
        {
          direction: "lateral",
          relation: "CERTIFIED_BY",
          fromType: "metrology_equipment",
          toType: "metrology_certificate",
          proof: "proven",
          source: "metrologie_certificats.equipement_id",
        },
        `SELECT c.equipement_id::text AS from_id, c.id::text AS to_id,
                NULL::float8 AS qty, NULL::text AS unit,
                c.date_etalonnage::text AS effective_at, c.id::text AS evidence_ref,
                c.resultat AS historical_status
           FROM public.metrologie_certificats c
          WHERE c.equipement_id = ANY($1::uuid[])
            AND c.deleted_at IS NULL
          ORDER BY c.date_etalonnage DESC
          LIMIT ${CAP}`,
        [ids]
      ))
    );
  }

  return out;
};

const expandNonConformity: Expander = async (rawIds, direction) => {
  const ids = uuids(rawIds);
  if (!ids.length) return [];

  if (direction === "downstream") {
    return [
      ...(await edgesFrom(
        {
          direction: "downstream",
          relation: "CORRECTED_BY",
          fromType: "non_conformity",
          toType: "quality_action",
          proof: "proven",
          source: "quality_action.non_conformity_id",
        },
        `SELECT a.non_conformity_id::text AS from_id, a.id::text AS to_id,
                NULL::float8 AS qty, NULL::text AS unit,
                a.created_at AS effective_at, a.id::text AS evidence_ref,
                a.status::text AS historical_status, a.correlation_id::text AS correlation_id
           FROM public.quality_action a
          WHERE a.non_conformity_id = ANY($1::uuid[])
          ORDER BY a.created_at ASC
          LIMIT ${CAP}`,
        [ids]
      )),
      ...(await edgesFrom(
        {
          direction: "downstream",
          relation: "COVERED_BY_DEROGATION",
          fromType: "non_conformity",
          toType: "derogation",
          proof: "proven",
          source: "quality_derogation.non_conformity_id",
        },
        `SELECT d.non_conformity_id::text AS from_id, d.id::text AS to_id,
                d.max_qty::float8 AS qty, d.unite AS unit,
                d.approved_at AS effective_at, d.id::text AS evidence_ref,
                d.status AS historical_status
           FROM public.quality_derogation d
          WHERE d.non_conformity_id = ANY($1::uuid[])
          LIMIT ${CAP}`,
        [ids]
      )),
    ];
  }

  // Remonter d'une NC vers les objets qu'elle concerne : c'est la requête que
  // fait la Qualité quand elle instruit un impact.
  return [
    ...(await ncAnchor(ids, "lot_id", "lot", "uuid")),
    ...(await ncAnchor(ids, "of_id", "of", "bigint")),
    ...(await ncAnchor(ids, "bon_livraison_id", "bon_livraison", "uuid")),
    ...(await ncAnchor(ids, "affaire_id", "affaire", "bigint")),
    ...(await ncAnchor(ids, "reception_ligne_id", "reception_ligne", "uuid")),
    ...(await ncAnchor(ids, "of_operation_id", "of_operation", "uuid")),
  ];
};

async function ncAnchor(
  ids: string[],
  column: string,
  type: TraceabilityNodeType,
  _cast: string
): Promise<NeighborEdge[]> {
  return edgesFrom(
    {
      direction: "upstream",
      relation: "AFFECTED_BY_NC",
      fromType: type,
      toType: "non_conformity",
      proof: "proven",
      source: `non_conformity.${column}`,
    },
    `SELECT nc.${column}::text AS from_id, nc.id::text AS to_id,
            nc.qty::float8 AS qty, nc.unite AS unit,
            nc.detection_date AS effective_at, nc.id::text AS evidence_ref,
            nc.status::text AS historical_status
       FROM public.non_conformity nc
      WHERE nc.id = ANY($1::uuid[]) AND nc.${column} IS NOT NULL
      LIMIT ${CAP}`,
    [ids]
  );
}

const expandDerogation: Expander = async (rawIds, direction) => {
  const ids = uuids(rawIds);
  if (!ids.length || direction !== "upstream") return [];
  return [
    ...(await edgesFrom(
      {
        direction: "upstream",
        relation: "COVERED_BY_DEROGATION",
        fromType: "lot",
        toType: "derogation",
        proof: "proven",
        source: "quality_derogation.lot_id",
      },
      `SELECT d.lot_id::text AS from_id, d.id::text AS to_id,
              d.max_qty::float8 AS qty, d.unite AS unit,
              d.approved_at AS effective_at, d.id::text AS evidence_ref,
              d.status AS historical_status
         FROM public.quality_derogation d
        WHERE d.id = ANY($1::uuid[]) AND d.lot_id IS NOT NULL
        LIMIT ${CAP}`,
      [ids]
    )),
  ];
};

const expandReleaseDecision: Expander = async (rawIds, direction) => {
  const ids = uuids(rawIds);
  if (!ids.length || direction !== "upstream") return [];
  return edgesFrom(
    {
      direction: "upstream",
      relation: "RELEASED_BY",
      fromType: "quality_control",
      toType: "release_decision",
      proof: "proven",
      source: "quality_release_decision.quality_control_id",
    },
    `SELECT d.quality_control_id::text AS from_id, d.id::text AS to_id,
            d.qty::float8 AS qty, d.unite AS unit,
            d.decided_at AS effective_at, d.id::text AS evidence_ref,
            d.decision AS historical_status
       FROM public.quality_release_decision d
      WHERE d.id = ANY($1::uuid[])
      LIMIT ${CAP}`,
    [ids]
  );
};

/* ------------------------------ LIVRAISON ---------------------------------- */

const expandBonLivraisonLigne: Expander = async (rawIds, direction) => {
  const ids = uuids(rawIds);
  if (!ids.length) return [];

  if (direction === "upstream") {
    return edgesFrom(
      {
        direction: "upstream",
        relation: "ALLOCATED_TO",
        fromType: "lot",
        toType: "bon_livraison_ligne",
        proof: "proven",
        source: "bon_livraison_ligne_allocations.lot_id",
      },
      `SELECT a.lot_id::text AS from_id, a.bon_livraison_ligne_id::text AS to_id,
              a.quantite::float8 AS qty, a.unite AS unit,
              a.created_at AS effective_at, a.id::text AS evidence_ref,
              NULL::text AS historical_status
         FROM public.bon_livraison_ligne_allocations a
        WHERE a.bon_livraison_ligne_id = ANY($1::uuid[]) AND a.lot_id IS NOT NULL
        LIMIT ${CAP}`,
      [ids]
    );
  }

  return edgesFrom(
    {
      direction: "downstream",
      relation: "DELIVERY_LINE_OF",
      fromType: "bon_livraison_ligne",
      toType: "bon_livraison",
      proof: "proven",
      source: "bon_livraison_ligne.bon_livraison_id",
    },
    `SELECT bll.id::text AS from_id, bll.bon_livraison_id::text AS to_id,
            bll.quantite::float8 AS qty, bll.unite AS unit,
            bll.created_at AS effective_at, bll.id::text AS evidence_ref,
            NULL::text AS historical_status
       FROM public.bon_livraison_ligne bll
      WHERE bll.id = ANY($1::uuid[])
      LIMIT ${CAP}`,
    [ids]
  );
};

const expandBonLivraison: Expander = async (rawIds, direction, ctx) => {
  const ids = uuids(rawIds);
  if (!ids.length) return [];
  const out: NeighborEdge[] = [];

  if (direction === "upstream") {
    out.push(
      ...(await edgesFrom(
        {
          direction: "upstream",
          relation: "DELIVERY_LINE_OF",
          fromType: "bon_livraison_ligne",
          toType: "bon_livraison",
          proof: "proven",
          source: "bon_livraison_ligne.bon_livraison_id",
        },
        `SELECT bll.id::text AS from_id, bll.bon_livraison_id::text AS to_id,
                bll.quantite::float8 AS qty, bll.unite AS unit,
                bll.created_at AS effective_at, bll.id::text AS evidence_ref,
                NULL::text AS historical_status
           FROM public.bon_livraison_ligne bll
          WHERE bll.bon_livraison_id = ANY($1::uuid[])
          ORDER BY bll.ordre ASC
          LIMIT ${CAP}`,
        [ids]
      )),
      ...(await edgesFrom(
        {
          direction: "upstream",
          relation: "ORDERED_BY",
          fromType: "commande",
          toType: "bon_livraison",
          proof: "proven",
          source: "bon_livraison.commande_id",
        },
        `SELECT bl.commande_id::text AS from_id, bl.id::text AS to_id,
                NULL::float8 AS qty, NULL::text AS unit,
                bl.date_creation::text AS effective_at, bl.id::text AS evidence_ref,
                bl.statut AS historical_status
           FROM public.bon_livraison bl
          WHERE bl.id = ANY($1::uuid[]) AND bl.commande_id IS NOT NULL
          LIMIT ${CAP}`,
        [ids]
      )),
      ...(await edgesFrom(
        {
          direction: "upstream",
          relation: "BELONGS_TO_AFFAIRE",
          fromType: "affaire",
          toType: "bon_livraison",
          proof: "proven",
          source: "bon_livraison.affaire_id",
        },
        `SELECT bl.affaire_id::text AS from_id, bl.id::text AS to_id,
                NULL::float8 AS qty, NULL::text AS unit,
                bl.date_creation::text AS effective_at, bl.id::text AS evidence_ref,
                bl.statut AS historical_status
           FROM public.bon_livraison bl
          WHERE bl.id = ANY($1::uuid[]) AND bl.affaire_id IS NOT NULL
          LIMIT ${CAP}`,
        [ids]
      ))
    );
  } else {
    out.push(
      ...(await edgesFrom(
        {
          direction: "downstream",
          relation: "DELIVERED_TO",
          fromType: "bon_livraison",
          toType: "client",
          proof: "proven",
          source: "bon_livraison.client_id",
        },
        `SELECT bl.id::text AS from_id, bl.client_id::text AS to_id,
                NULL::float8 AS qty, NULL::text AS unit,
                COALESCE(bl.date_livraison::text, bl.date_expedition::text) AS effective_at,
                bl.id::text AS evidence_ref, bl.statut AS historical_status
           FROM public.bon_livraison bl
          WHERE bl.id = ANY($1::uuid[]) AND bl.client_id IS NOT NULL
          LIMIT ${CAP}`,
        [ids]
      ))
    );
  }

  if (direction === ctx.lateralOn) {
    out.push(
      ...(await edgesFrom(
        {
          direction: "lateral",
          relation: "PROVEN_BY",
          fromType: "bon_livraison",
          toType: "delivery_proof",
          proof: "proven",
          source: "bon_livraison_delivery_proofs.bon_livraison_id",
        },
        `SELECT p.bon_livraison_id::text AS from_id, p.id::text AS to_id,
                NULL::float8 AS qty, NULL::text AS unit,
                p.delivered_at AS effective_at, p.id::text AS evidence_ref,
                p.proof_type AS historical_status, p.correlation_id::text AS correlation_id
           FROM public.bon_livraison_delivery_proofs p
          WHERE p.bon_livraison_id = ANY($1::uuid[])
          ORDER BY p.delivered_at DESC
          LIMIT ${CAP}`,
        [ids]
      ))
    );
  }

  return out;
};

/* ------------------------------ COMMERCE ----------------------------------- */

const expandAffaire: Expander = async (rawIds, direction) => {
  const ids = bigints(rawIds);
  if (!ids.length) return [];

  if (direction === "downstream") {
    return [
      ...(await edgesFrom(
        {
          direction: "downstream",
          relation: "BELONGS_TO_AFFAIRE",
          fromType: "affaire",
          toType: "of",
          proof: "proven",
          source: "ordres_fabrication.affaire_id",
        },
        `SELECT o.affaire_id::text AS from_id, o.id::text AS to_id,
                o.quantite_lancee::float8 AS qty, NULL::text AS unit,
                o.created_at AS effective_at, o.id::text AS evidence_ref,
                o.statut::text AS historical_status
           FROM public.ordres_fabrication o
          WHERE o.affaire_id = ANY($1::bigint[])
          ORDER BY o.id DESC
          LIMIT ${CAP}`,
        [ids]
      )),
      ...(await edgesFrom(
        {
          direction: "downstream",
          relation: "BELONGS_TO_AFFAIRE",
          fromType: "affaire",
          toType: "bon_livraison",
          proof: "proven",
          source: "bon_livraison.affaire_id",
        },
        `SELECT bl.affaire_id::text AS from_id, bl.id::text AS to_id,
                NULL::float8 AS qty, NULL::text AS unit,
                bl.date_creation::text AS effective_at, bl.id::text AS evidence_ref,
                bl.statut AS historical_status
           FROM public.bon_livraison bl
          WHERE bl.affaire_id = ANY($1::bigint[])
          ORDER BY bl.date_creation DESC
          LIMIT ${CAP}`,
        [ids]
      )),
    ];
  }

  return [
    ...(await edgesFrom(
      {
        direction: "upstream",
        relation: "ORDERED_BY",
        fromType: "commande",
        toType: "affaire",
        proof: "proven",
        source: "commande_to_affaire",
      },
      `SELECT cta.commande_id::text AS from_id, cta.affaire_id::text AS to_id,
              NULL::float8 AS qty, NULL::text AS unit,
              cta.date_conversion AS effective_at, cta.id::text AS evidence_ref,
              cta.role AS historical_status
         FROM public.commande_to_affaire cta
        WHERE cta.affaire_id = ANY($1::bigint[])
        LIMIT ${CAP}`,
      [ids]
    )),
    ...(await edgesFrom(
      {
        direction: "upstream",
        relation: "QUOTED_BY",
        fromType: "devis",
        toType: "affaire",
        proof: "proven",
        source: "affaire.devis_id",
      },
      `SELECT a.devis_id::text AS from_id, a.id::text AS to_id,
              NULL::float8 AS qty, NULL::text AS unit,
              a.date_ouverture::text AS effective_at, a.id::text AS evidence_ref,
              a.statut AS historical_status
         FROM public.affaire a
        WHERE a.id = ANY($1::bigint[]) AND a.devis_id IS NOT NULL
        LIMIT ${CAP}`,
      [ids]
    )),
  ];
};

const expandCommande: Expander = async (rawIds, direction) => {
  const ids = bigints(rawIds);
  if (!ids.length) return [];

  if (direction === "downstream") {
    return [
      ...(await edgesFrom(
        {
          direction: "downstream",
          relation: "ORDER_LINE_OF",
          fromType: "commande",
          toType: "commande_ligne",
          proof: "proven",
          source: "commande_ligne.commande_id",
        },
        `SELECT cl.commande_id::text AS from_id, cl.id::text AS to_id,
                cl.quantite::float8 AS qty, cl.unite AS unit,
                NULL::timestamptz AS effective_at, cl.id::text AS evidence_ref,
                NULL::text AS historical_status
           FROM public.commande_ligne cl
          WHERE cl.commande_id = ANY($1::bigint[])
          ORDER BY cl.id ASC
          LIMIT ${CAP}`,
        [ids]
      )),
      ...(await edgesFrom(
        {
          direction: "downstream",
          relation: "ORDERED_BY",
          fromType: "commande",
          toType: "bon_livraison",
          proof: "proven",
          source: "bon_livraison.commande_id",
        },
        `SELECT bl.commande_id::text AS from_id, bl.id::text AS to_id,
                NULL::float8 AS qty, NULL::text AS unit,
                bl.date_creation::text AS effective_at, bl.id::text AS evidence_ref,
                bl.statut AS historical_status
           FROM public.bon_livraison bl
          WHERE bl.commande_id = ANY($1::bigint[])
          ORDER BY bl.date_creation DESC
          LIMIT ${CAP}`,
        [ids]
      )),
      ...(await edgesFrom(
        {
          direction: "downstream",
          relation: "ORDER_LINE_OF",
          fromType: "commande",
          toType: "of",
          proof: "proven",
          source: "ordres_fabrication.commande_id",
        },
        `SELECT o.commande_id::text AS from_id, o.id::text AS to_id,
                o.quantite_lancee::float8 AS qty, NULL::text AS unit,
                o.created_at AS effective_at, o.id::text AS evidence_ref,
                o.statut::text AS historical_status
           FROM public.ordres_fabrication o
          WHERE o.commande_id = ANY($1::bigint[])
          ORDER BY o.id DESC
          LIMIT ${CAP}`,
        [ids]
      )),
    ];
  }

  return [
    ...(await edgesFrom(
      {
        direction: "upstream",
        relation: "ORDERED_BY",
        fromType: "client",
        toType: "commande",
        proof: "proven",
        source: "commande_client.client_id",
      },
      `SELECT cc.client_id::text AS from_id, cc.id::text AS to_id,
              cc.total_ht::float8 AS qty, NULL::text AS unit,
              cc.date_commande::text AS effective_at, cc.id::text AS evidence_ref,
              cc.order_type AS historical_status
         FROM public.commande_client cc
        WHERE cc.id = ANY($1::bigint[]) AND cc.client_id IS NOT NULL
        LIMIT ${CAP}`,
      [ids]
    )),
    ...(await edgesFrom(
      {
        direction: "upstream",
        relation: "QUOTED_BY",
        fromType: "devis",
        toType: "commande",
        proof: "proven",
        source: "commande_client.devis_id",
      },
      `SELECT cc.devis_id::text AS from_id, cc.id::text AS to_id,
              NULL::float8 AS qty, NULL::text AS unit,
              cc.date_commande::text AS effective_at, cc.id::text AS evidence_ref,
              NULL::text AS historical_status
         FROM public.commande_client cc
        WHERE cc.id = ANY($1::bigint[]) AND cc.devis_id IS NOT NULL
        LIMIT ${CAP}`,
      [ids]
    )),
  ];
};

const expandDevis: Expander = async (rawIds, direction) => {
  const ids = bigints(rawIds);
  if (!ids.length || direction !== "downstream") return [];
  return [
    ...(await edgesFrom(
      {
        direction: "downstream",
        relation: "QUOTED_BY",
        fromType: "devis",
        toType: "commande",
        proof: "proven",
        source: "commande_client.devis_id",
      },
      `SELECT cc.devis_id::text AS from_id, cc.id::text AS to_id,
              NULL::float8 AS qty, NULL::text AS unit,
              cc.date_commande::text AS effective_at, cc.id::text AS evidence_ref,
              NULL::text AS historical_status
         FROM public.commande_client cc
        WHERE cc.devis_id = ANY($1::bigint[])
        LIMIT ${CAP}`,
      [ids]
    )),
    ...(await edgesFrom(
      {
        direction: "downstream",
        relation: "QUOTED_BY",
        fromType: "devis",
        toType: "affaire",
        proof: "proven",
        source: "affaire.devis_id",
      },
      `SELECT a.devis_id::text AS from_id, a.id::text AS to_id,
              NULL::float8 AS qty, NULL::text AS unit,
              a.date_ouverture::text AS effective_at, a.id::text AS evidence_ref,
              a.statut AS historical_status
         FROM public.affaire a
        WHERE a.devis_id = ANY($1::bigint[])
        LIMIT ${CAP}`,
      [ids]
    )),
  ];
};

const expandArticle: Expander = async (rawIds, direction) => {
  const ids = uuids(rawIds);
  if (!ids.length) return [];
  if (direction === "upstream") {
    return edgesFrom(
      {
        direction: "upstream",
        relation: "ARTICLE_OF",
        fromType: "piece_technique",
        toType: "article",
        proof: "proven",
        source: "articles.piece_technique_id",
      },
      `SELECT a.piece_technique_id::text AS from_id, a.id::text AS to_id,
              NULL::float8 AS qty, a.unite AS unit,
              a.created_at AS effective_at, a.id::text AS evidence_ref,
              a.status AS historical_status
         FROM public.articles a
        WHERE a.id = ANY($1::uuid[]) AND a.piece_technique_id IS NOT NULL
        LIMIT ${CAP}`,
      [ids]
    );
  }
  // Aval d'un article : on ne déplie PAS tous ses lots (volume non borné et
  // sans valeur de preuve). L'opérateur part d'un lot, d'un OF ou d'un BL.
  return [];
};

const expandPieceVersion: Expander = async (rawIds, direction) => {
  const ids = uuids(rawIds);
  if (!ids.length) return [];
  if (direction === "upstream") {
    return edgesFrom(
      {
        direction: "upstream",
        relation: "USES_VERSION",
        fromType: "piece_technique",
        toType: "piece_version",
        proof: "proven",
        source: "piece_technique_versions.piece_technique_id",
      },
      `SELECT v.piece_technique_id::text AS from_id, v.id::text AS to_id,
              NULL::float8 AS qty, NULL::text AS unit,
              COALESCE(v.date_effet::text, v.created_at::text) AS effective_at,
              v.id::text AS evidence_ref, v.statut AS historical_status
         FROM public.piece_technique_versions v
        WHERE v.id = ANY($1::uuid[])
        LIMIT ${CAP}`,
      [ids]
    );
  }
  return edgesFrom(
    {
      direction: "downstream",
      relation: "USES_VERSION",
      fromType: "piece_version",
      toType: "of",
      proof: "proven",
      source: "of_technical_snapshots.piece_technique_version_id",
    },
    `SELECT s.piece_technique_version_id::text AS from_id, s.of_id::text AS to_id,
            NULL::float8 AS qty, NULL::text AS unit,
            s.created_at AS effective_at, s.snapshot_sha256 AS evidence_ref,
            NULL::text AS historical_status
       FROM public.of_technical_snapshots s
      WHERE s.piece_technique_version_id = ANY($1::uuid[])
      ORDER BY s.created_at DESC
      LIMIT ${CAP}`,
    [ids]
  );
};

/* -------------------------------------------------------------------------- */
/* Table historique `traceability_links`                                      */
/* -------------------------------------------------------------------------- */

/**
 * `public.traceability_links` (patch 20260228) n'a JAMAIS eu d'écrivain
 * applicatif : l'audit de #142 confirme qu'aucun service n'y insère. Elle reste
 * lue pour ne rien perdre d'un éventuel import, mais elle n'est PAS une source
 * de vérité : ses arêtes sortent en `declared` et jamais en `proven`.
 * Cf. ADR-0028.
 */
async function legacyLinkEdges(
  refs: TraceabilityNodeRef[],
  direction: "upstream" | "downstream"
): Promise<NeighborEdge[]> {
  if (!refs.length) return [];
  const types = refs.map((r) => r.type);
  const idsList = refs.map((r) => r.id);
  // Le nœud d'ancrage est la SOURCE du lien quand on descend, la CIBLE quand on
  // remonte. Les colonnes restituées gardent toujours le sens réel du lien.
  const anchorIsSource = direction === "downstream";

  const rows = await safeQuery(
    `SELECT tl.source_id AS from_id,
            tl.target_id AS to_id,
            tl.source_type AS from_type,
            tl.target_type AS to_type,
            tl.link_type, tl.created_at AS effective_at, tl.id::text AS evidence_ref
       FROM public.traceability_links tl
       JOIN unnest($1::text[], $2::text[]) AS seed(t, i)
         ON seed.t = ${anchorIsSource ? "tl.source_type" : "tl.target_type"}
        AND seed.i = ${anchorIsSource ? "tl.source_id" : "tl.target_id"}
      ORDER BY tl.created_at DESC
      LIMIT ${CAP}`,
    [types, idsList]
  );

  const out: NeighborEdge[] = [];
  for (const row of rows) {
    const fromId = str(row.from_id);
    const toId = str(row.to_id);
    const fromType = str(row.from_type) as TraceabilityNodeType | null;
    const toType = str(row.to_type) as TraceabilityNodeType | null;
    if (!fromId || !toId || !fromType || !toType) continue;
    if (!NODE_TYPE_SET.has(fromType) || !NODE_TYPE_SET.has(toType)) continue;
    out.push({
      direction,
      relation: "LEGACY_LINK",
      from: { type: fromType, id: fromId },
      to: { type: toType, id: toId },
      proof_level: "declared",
      proof_source: "traceability_links (table historique, sans écrivain applicatif)",
      effective_at: iso(row.effective_at),
      qty: null,
      unit: null,
      correlation_id: null,
      evidence_ref: str(row.evidence_ref),
      historical_status: null,
      meta: { link_type: str(row.link_type) },
    });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Point d'entrée                                                             */
/* -------------------------------------------------------------------------- */

const EXPANDERS: Partial<Record<TraceabilityNodeType, Expander>> = {
  lot: expandLot,
  of: expandOf,
  of_operation: expandOfOperation,
  pointage: expandPointage,
  of_receipt: expandOfReceipt,
  stock_movement: expandStockMovement,
  reservation: expandReservation,
  reception_ligne: expandReceptionLigne,
  reception_fournisseur: expandReceptionFournisseur,
  reception_inspection: expandReceptionInspection,
  commande_fournisseur: expandCommandeFournisseur,
  fournisseur: expandFournisseur,
  quality_control: expandQualityControl,
  quality_measurement: expandQualityMeasurement,
  metrology_equipment: expandMetrologyEquipment,
  non_conformity: expandNonConformity,
  derogation: expandDerogation,
  release_decision: expandReleaseDecision,
  bon_livraison: expandBonLivraison,
  bon_livraison_ligne: expandBonLivraisonLigne,
  affaire: expandAffaire,
  commande: expandCommande,
  devis: expandDevis,
  article: expandArticle,
  piece_version: expandPieceVersion,
};

/**
 * Voisinage d'une FRONTIÈRE complète : un aller-retour par type présent, pas
 * par nœud. C'est le contrat qui rend le moteur linéaire en profondeur.
 */
export async function repoFetchNeighborsBatched(
  refs: TraceabilityNodeRef[],
  direction: "upstream" | "downstream",
  ctx: NeighborContext
): Promise<NeighborEdge[]> {
  if (!refs.length) return [];

  const byType = new Map<TraceabilityNodeType, string[]>();
  for (const ref of refs) {
    const arr = byType.get(ref.type);
    if (arr) arr.push(ref.id);
    else byType.set(ref.type, [ref.id]);
  }

  const jobs: Array<Promise<NeighborEdge[]>> = [];
  for (const [type, ids] of byType) {
    const expander = EXPANDERS[type];
    if (!expander) continue;
    jobs.push(expander(ids, direction, ctx));
  }
  jobs.push(legacyLinkEdges(refs, direction));

  const results = await Promise.all(jobs);
  const out: NeighborEdge[] = [];
  for (const chunk of results) out.push(...chunk);
  return out;
}
