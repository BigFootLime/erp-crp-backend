// Traçabilité industrielle 360 (#142) — service unique.
//
// UN SEUL moteur : `/traceability/chain` (contrat historique), `/v2/chain`,
// `/v2/expand` et `/v2/impact` passent tous par `runChain`. Il n'existe pas de
// second graphe « 360 » à maintenir en parallèle.
//
// Le service n'écrit RIEN. Pas une ligne. La traçabilité est une vue de lecture
// transversale : elle ne recalcule pas un stock, ne décide pas d'une conformité,
// ne libère pas un lot, ne réceptionne pas un OF, ne clôture pas une NC,
// n'expédie pas un BL et ne génère pas de facture.

import { HttpError } from "../../../utils/httpError";

import {
  expandGraph,
  summarizeByType,
  summarizeProof,
  type GraphEdge,
} from "../domain/traceability-graph";
import {
  DATA_QUALITY_LABELS,
  IMPACT_CLASSIFICATION_LABELS,
  NODE_TYPE_LABELS,
  PROOF_LEVEL_LABELS,
  nodeIdShapeIsValid,
  nodeKey,
  relationInverseLabel,
  relationLabel,
  type DataQualityIssue,
  type ImpactClassification,
  type TraceabilityDirection,
  type TraceabilityNodeRef,
  type TraceabilityNodeType,
  type TraceabilityProofLevel,
  type TraceabilityRelationType,
} from "../domain/traceability-model";
import {
  TRACEABILITY_LIMITS,
  capabilitiesForRole,
  clampDepth,
  clampEdges,
  clampNodes,
  clampSearchLimit,
  nodeTypeIsVisible,
  type TraceabilityCapabilitySet,
} from "../domain/traceability-policy";
import {
  repoFetchNeighborsBatched,
  type NeighborContext,
} from "../repository/traceability-neighbors.repository";
import {
  repoHydrateNodesBatched,
  type TraceabilityNodeDTO,
} from "../repository/traceability-hydrate.repository";
import { repoSearchTraceability } from "../repository/traceability-search.repository";
import { repoAuditTraceabilityIssues } from "../repository/traceability-quality.repository";

import type {
  TraceabilityChainResponse,
  TraceabilityCoverage,
  TraceabilityEdgeDTO,
  TraceabilityImpactItem,
  TraceabilityImpactResponse,
  TraceabilitySearchResponse,
  TraceabilityScope,
} from "../types/traceability-360.types";

/* -------------------------------------------------------------------------- */
/* Tables autoritaires réellement interrogées                                 */
/* -------------------------------------------------------------------------- */

const AUTHORITATIVE_SOURCES = [
  "lots",
  "articles",
  "stock_movements",
  "stock_movement_lines",
  "stock_lot_genealogy_edges",
  "stock_reservations",
  "of_material_consumptions",
  "ordres_fabrication",
  "of_operations",
  "of_output_lots",
  "of_receipts",
  "of_technical_snapshots",
  "production_pointages",
  "receptions_fournisseurs",
  "reception_fournisseur_lignes",
  "reception_fournisseur_stock_receipts",
  "reception_incoming_inspections",
  "quality_control",
  "quality_control_points",
  "quality_release_decision",
  "non_conformity",
  "quality_action",
  "quality_derogation",
  "metrologie_equipements",
  "metrologie_certificats",
  "bon_livraison",
  "bon_livraison_ligne",
  "bon_livraison_ligne_allocations",
  "bon_livraison_delivery_proofs",
  "asbuilt_pack_versions",
] as const;

/* -------------------------------------------------------------------------- */
/* Paramètres                                                                 */
/* -------------------------------------------------------------------------- */

export type ChainParams = {
  seed: TraceabilityNodeRef;
  role: string | null | undefined;
  direction?: TraceabilityDirection;
  asOf?: string | null;
  maxDepth?: number;
  maxNodes?: number;
  maxEdges?: number;
  nodeTypes?: TraceabilityNodeType[] | null;
  relations?: TraceabilityRelationType[] | null;
  periodFrom?: string | null;
  periodTo?: string | null;
  /** Analyse de qualité de données : coûteuse, désactivée pour `/expand`. */
  withQualityAudit?: boolean;
};

function directionsFor(direction: TraceabilityDirection): Array<"upstream" | "downstream"> {
  if (direction === "upstream") return ["upstream"];
  if (direction === "downstream") return ["downstream"];
  return ["upstream", "downstream"];
}

function normalizeAsOf(raw: string | null | undefined): string {
  if (!raw) return new Date().toISOString();
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    throw new HttpError(422, "TRACEABILITY_AS_OF_INVALID", "La date de référence est invalide.");
  }
  return d.toISOString();
}

function toEdgeDTO(edge: GraphEdge): TraceabilityEdgeDTO {
  return {
    edge_id: edge.edge_id,
    source: edge.source,
    target: edge.target,
    relation: edge.relation,
    relation_label: relationLabel(edge.relation),
    relation_inverse_label: relationInverseLabel(edge.relation),
    direction: edge.direction,
    depth: edge.depth,
    proof_level: edge.proof_level,
    proof_label: PROOF_LEVEL_LABELS[edge.proof_level],
    proof_source: edge.proof_source,
    evidence_ref: edge.evidence_ref,
    effective_at: edge.effective_at,
    qty: edge.qty,
    unit: edge.unit,
    correlation_id: edge.correlation_id,
    historical_status: edge.historical_status,
    meta: edge.meta,
  };
}

function coverageState(
  complete: boolean,
  hidden: number,
  issues: DataQualityIssue[]
): TraceabilityCoverage["state"] {
  if (issues.some((i) => i.level === "danger")) return "INTEGRITY_ISSUE";
  if (hidden > 0) return "PERMISSION_LIMITED";
  if (issues.some((i) => i.code === "LEGACY_IMPORT_INCOMPLETE")) return "HISTORICALLY_INCOMPLETE";
  return complete ? "COMPLETE" : "PARTIAL";
}

const COVERAGE_STATE_LABELS: Record<TraceabilityCoverage["state"], string> = {
  COMPLETE: "Chaîne complète",
  PARTIAL: "Chaîne partielle",
  PERMISSION_LIMITED: "Chaîne limitée par vos autorisations",
  HISTORICALLY_INCOMPLETE: "Historique incomplet",
  INTEGRITY_ISSUE: "Anomalie d'intégrité détectée",
};

/* -------------------------------------------------------------------------- */
/* Chaîne                                                                     */
/* -------------------------------------------------------------------------- */

export async function svcGetTraceabilityChain(
  params: ChainParams
): Promise<TraceabilityChainResponse> {
  const caps = capabilitiesForRole(params.role);

  if (!nodeIdShapeIsValid(params.seed)) {
    throw new HttpError(
      422,
      "TRACEABILITY_SEED_INVALID",
      "L'identifiant du point de départ n'est pas au format attendu pour ce type."
    );
  }

  // Garde d'entrée : le type du point de départ doit être visible. Sinon 403,
  // JAMAIS 404 déguisé et jamais un graphe vide qui laisserait deviner.
  if (!nodeTypeIsVisible(caps, params.seed.type)) {
    throw new HttpError(
      403,
      "TRACEABILITY_NODE_FORBIDDEN",
      `Vous n'avez pas accès aux objets de type « ${NODE_TYPE_LABELS[params.seed.type]} ».`
    );
  }

  const asOf = normalizeAsOf(params.asOf);
  const direction: TraceabilityDirection = params.direction ?? "both";
  const directions = directionsFor(direction);
  const maxDepth = clampDepth(params.maxDepth);
  const maxNodes = clampNodes(params.maxNodes);
  const maxEdges = clampEdges(params.maxEdges);

  const nodeTypeFilter = params.nodeTypes?.length ? new Set(params.nodeTypes) : null;
  const relationFilter = params.relations?.length ? new Set(params.relations) : null;

  const ctx: NeighborContext = {
    lateralOn: directions.includes("downstream") ? "downstream" : "upstream",
    asOf,
  };

  const graph = await expandGraph({
    seeds: [params.seed],
    directions,
    maxDepth,
    maxNodes,
    maxEdges,
    maxNeighborsPerNode: TRACEABILITY_LIMITS.MAX_NEIGHBORS_PER_NODE,
    fetchNeighbors: (refs, dir) => repoFetchNeighborsBatched(refs, dir, ctx),
    isVisible: (type) => nodeTypeIsVisible(caps, type),
    nodeTypeFilter,
    relationFilter,
    periodFrom: params.periodFrom ?? null,
    periodTo: params.periodTo ?? null,
  });

  const hydrated = await repoHydrateNodesBatched(graph.nodes, caps);
  const seedKey = nodeKey(params.seed);
  const seedNode = hydrated.get(seedKey);
  if (!seedNode) {
    throw new HttpError(404, "TRACEABILITY_SEED_NOT_FOUND", "Point de départ introuvable.");
  }
  if (seedNode.meta?.orphan === true) {
    throw new HttpError(404, "TRACEABILITY_SEED_NOT_FOUND", "Point de départ introuvable.");
  }

  const issues: DataQualityIssue[] = [...graph.issues];
  if (params.withQualityAudit !== false) {
    issues.push(...(await repoAuditTraceabilityIssues(graph.nodes, hydrated, graph.edges)));
  }

  const edgeDTOs = graph.edges.map(toEdgeDTO);
  const proofLevels = summarizeProof(graph.edges);
  const complete =
    !graph.truncated.depth_reached &&
    !graph.truncated.node_budget_reached &&
    !graph.truncated.edge_budget_reached &&
    graph.truncated.branches.length === 0;

  const state = coverageState(complete, graph.coverage.hidden_by_permission, issues);

  const scope: TraceabilityScope = {
    direction,
    max_depth: maxDepth,
    max_nodes: maxNodes,
    max_edges: maxEdges,
    node_types: params.nodeTypes?.length ? params.nodeTypes : null,
    relations: params.relations?.length ? params.relations : null,
    period_from: params.periodFrom ?? null,
    period_to: params.periodTo ?? null,
  };

  const paths: Record<string, string[]> = {};
  for (const [key, value] of graph.paths) paths[key] = value;

  const nodes = graph.nodes
    .map((ref) => hydrated.get(nodeKey(ref)))
    .filter((n): n is TraceabilityNodeDTO => Boolean(n));

  return {
    seed: seedNode,
    as_of: asOf,
    generated_at: new Date().toISOString(),
    scope,
    capabilities: caps as Record<string, boolean> as TraceabilityChainResponse["capabilities"],
    nodes,
    edges: edgeDTOs,
    paths,
    summary: {
      by_type: summarizeByType(graph.nodes).map((e) => ({
        type: e.type,
        label: NODE_TYPE_LABELS[e.type] ?? e.type,
        count: e.count,
      })),
      node_count: nodes.length,
      edge_count: edgeDTOs.length,
      upstream_count: edgeDTOs.filter((e) => e.direction === "upstream").length,
      downstream_count: edgeDTOs.filter((e) => e.direction === "downstream").length,
    },
    coverage: {
      complete,
      visited_nodes: graph.coverage.visited_nodes,
      expanded_nodes: graph.coverage.expanded_nodes,
      frontier_pending: graph.coverage.frontier_pending,
      hidden_by_permission: graph.coverage.hidden_by_permission,
      filtered_out: graph.coverage.filtered_out,
      proof_levels: proofLevels,
      state,
      state_label: COVERAGE_STATE_LABELS[state],
    },
    data_quality_issues: issues,
    sources: [...AUTHORITATIVE_SOURCES],
    truncated: graph.truncated,
    // Le graphe est déplié à la demande branche par branche : la pagination
    // d'un graphe se fait par expansion, pas par page. `next_cursor` reste dans
    // le contrat pour les listes plates (recherche, impact) et vaut `null` ici.
    next_cursor: null,
  };
}

/* -------------------------------------------------------------------------- */
/* Expansion d'une branche                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Déplier UN nœud, dans UNE direction, sur UN niveau. Même moteur, mêmes
 * règles, mêmes DTO — ce n'est pas un second graphe, c'est le même avec
 * `maxDepth = 1`.
 */
export async function svcExpandTraceabilityNode(params: {
  node: TraceabilityNodeRef;
  role: string | null | undefined;
  direction: TraceabilityDirection;
  asOf?: string | null;
  maxNodes?: number;
  maxEdges?: number;
}): Promise<TraceabilityChainResponse> {
  return svcGetTraceabilityChain({
    seed: params.node,
    role: params.role,
    direction: params.direction,
    asOf: params.asOf,
    maxDepth: 1,
    maxNodes: params.maxNodes ?? 80,
    maxEdges: params.maxEdges ?? 200,
    withQualityAudit: false,
  });
}

/* -------------------------------------------------------------------------- */
/* Recherche                                                                  */
/* -------------------------------------------------------------------------- */

export async function svcSearchTraceability(params: {
  term: string;
  role: string | null | undefined;
  types?: TraceabilityNodeType[] | null;
  limit?: number;
  offset?: number;
}): Promise<TraceabilitySearchResponse> {
  const caps = capabilitiesForRole(params.role);
  const limit = clampSearchLimit(params.limit);
  const offset = Math.max(0, Math.trunc(params.offset ?? 0));
  const term = params.term.trim();

  const result = await repoSearchTraceability({
    term,
    caps,
    types: params.types?.length ? new Set(params.types) : null,
    limit,
    offset,
  });

  return {
    term,
    hits: result.hits,
    has_more: result.has_more,
    limit,
    offset,
    searched_types: result.searched_types,
    capabilities: caps as Record<string, boolean> as TraceabilitySearchResponse["capabilities"],
  };
}

/* -------------------------------------------------------------------------- */
/* Prévisualisation d'impact                                                  */
/* -------------------------------------------------------------------------- */

/** Objets qui constituent une CONSÉQUENCE et non une simple étape intermédiaire. */
const IMPACT_TARGET_TYPES: ReadonlySet<TraceabilityNodeType> = new Set<TraceabilityNodeType>([
  "lot",
  "of",
  "bon_livraison",
  "bon_livraison_ligne",
  "client",
  "quality_control",
  "non_conformity",
]);

/**
 * Prévisualisation STRICTEMENT en lecture.
 *
 * Elle ne bloque aucun stock, ne rappelle aucun produit, ne contacte aucun
 * client, n'annule aucun BL, ne crée aucun avoir, ne clôture aucune NC et ne
 * modifie aucun OF. Elle produit une liste classée avec, pour chaque item, le
 * CHEMIN DE PREUVE qui la justifie. La décision et l'exécution appartiennent à
 * Qualité, Stock, ADV ou Facturation.
 */
export async function svcPreviewTraceabilityImpact(params: {
  seed: TraceabilityNodeRef;
  role: string | null | undefined;
  since?: string | null;
  asOf?: string | null;
  maxDepth?: number;
  nodeTypes?: TraceabilityNodeType[] | null;
}): Promise<TraceabilityImpactResponse> {
  const chain = await svcGetTraceabilityChain({
    seed: params.seed,
    role: params.role,
    direction: "downstream",
    asOf: params.asOf,
    maxDepth: clampDepth(params.maxDepth ?? 6),
    maxNodes: TRACEABILITY_LIMITS.MAX_NODES,
    maxEdges: TRACEABILITY_LIMITS.MAX_EDGES,
    nodeTypes: params.nodeTypes ?? null,
    periodFrom: params.since ?? null,
    withQualityAudit: true,
  });

  const edgeById = new Map(chain.edges.map((e) => [e.edge_id, e]));
  const seedKey = chain.seed.node_id;
  const since = params.since ? Date.parse(params.since) : null;

  const items: TraceabilityImpactItem[] = [];
  const counts: Record<ImpactClassification, number> = {
    CONFIRMED: 0,
    TO_ANALYSE: 0,
    NO_PROVEN_IMPACT: 0,
    OUT_OF_SCOPE: 0,
    INSUFFICIENT_DATA: 0,
  };

  for (const node of chain.nodes) {
    if (node.node_id === seedKey) continue;
    if (!IMPACT_TARGET_TYPES.has(node.type)) continue;

    const pathIds = chain.paths[node.node_id] ?? [];
    const proofPath = pathIds
      .map((id) => edgeById.get(id))
      .filter((e): e is TraceabilityEdgeDTO => Boolean(e));

    let classification: ImpactClassification;
    let reason: string;
    let weakest: TraceabilityProofLevel = "proven";

    if (!proofPath.length) {
      classification = "INSUFFICIENT_DATA";
      reason = "Aucun chemin de preuve reconstituable jusqu'à cet objet.";
      weakest = "unknown";
    } else {
      for (const edge of proofPath) {
        if (edge.proof_level === "unknown") weakest = "unknown";
        else if (edge.proof_level === "declared" && weakest !== "unknown") weakest = "declared";
      }

      // Hors périmètre temporel : l'objet est antérieur à la fenêtre demandée
      // (ex. dernière preuve métrologique conforme connue).
      const lastDated = [...proofPath].reverse().find((e) => e.effective_at);
      const objectDate = lastDated?.effective_at ?? node.date;
      const objectTs = objectDate ? Date.parse(objectDate) : NaN;

      if (since !== null && !Number.isNaN(objectTs) && objectTs < since) {
        classification = "OUT_OF_SCOPE";
        reason = "Objet antérieur à la fenêtre d'analyse demandée.";
      } else if (weakest === "unknown") {
        classification = "INSUFFICIENT_DATA";
        reason = "Le chemin comporte un lien historique non renseigné.";
      } else if (weakest === "declared") {
        classification = "TO_ANALYSE";
        reason =
          "Le chemin repose sur une référence documentaire déclarée et non contrainte : à vérifier manuellement.";
      } else {
        classification = "CONFIRMED";
        reason = "Chaîne prouvée de bout en bout par des enregistrements autoritaires.";
      }
    }

    counts[classification] += 1;
    items.push({
      node,
      classification,
      classification_label: IMPACT_CLASSIFICATION_LABELS[classification],
      proof_path: proofPath,
      weakest_proof: weakest,
      reason,
      qty: proofPath.length ? (proofPath[proofPath.length - 1]?.qty ?? node.qty) : node.qty,
      unit: proofPath.length ? (proofPath[proofPath.length - 1]?.unit ?? node.unit) : node.unit,
      date: node.date,
    });

    if (items.length >= TRACEABILITY_LIMITS.IMPACT_MAX_ITEMS) break;
  }

  if (items.length === 0) {
    counts.NO_PROVEN_IMPACT = 1;
    items.push({
      node: chain.seed,
      classification: "NO_PROVEN_IMPACT",
      classification_label: IMPACT_CLASSIFICATION_LABELS.NO_PROVEN_IMPACT,
      proof_path: [],
      weakest_proof: "proven",
      reason:
        "Aucun usage aval prouvé n'a été trouvé dans le périmètre demandé. Ce n'est pas une garantie d'absence d'impact : élargissez la période ou la profondeur.",
      qty: null,
      unit: null,
      date: chain.seed.date,
    });
  }

  items.sort((a, b) => {
    const order: ImpactClassification[] = [
      "CONFIRMED",
      "TO_ANALYSE",
      "INSUFFICIENT_DATA",
      "OUT_OF_SCOPE",
      "NO_PROVEN_IMPACT",
    ];
    const d = order.indexOf(a.classification) - order.indexOf(b.classification);
    if (d !== 0) return d;
    return (b.date ?? "").localeCompare(a.date ?? "");
  });

  return {
    seed: chain.seed,
    as_of: chain.as_of,
    generated_at: chain.generated_at,
    scope: { ...chain.scope, since: params.since ?? null },
    read_only: true,
    items,
    counts,
    coverage: chain.coverage,
    data_quality_issues: chain.data_quality_issues,
    truncated: chain.truncated,
  };
}

/* -------------------------------------------------------------------------- */
/* Adaptateur du contrat historique                                           */
/* -------------------------------------------------------------------------- */

export type LegacyChainResult = {
  seed: { type: string; id: string };
  nodes: Array<{
    node_id: string;
    type: string;
    id: string;
    label: string;
    meta: Record<string, unknown> | null;
  }>;
  edges: Array<{
    edge_id: string;
    source: string;
    target: string;
    relation: string;
    meta: Record<string, unknown> | null;
  }>;
  highlights: Array<{
    node_id: string;
    code: string;
    level: "info" | "warning" | "danger";
    message: string;
  }>;
  truncated: { maxDepthReached: boolean; maxNodesReached: boolean; maxEdgesReached: boolean };
};

/**
 * `GET /traceability/chain` reste servi à l'identique pour ne casser aucun
 * écran déjà déployé. Il est simplement recâblé sur le nouveau moteur (donc
 * sans N+1) et protégé par RBAC, ce qu'il n'était pas.
 */
export function toLegacyChainResult(response: TraceabilityChainResponse): LegacyChainResult {
  return {
    seed: { type: response.seed.type, id: response.seed.id },
    nodes: response.nodes.map((n) => ({
      node_id: n.node_id,
      type: n.type,
      id: n.id,
      label: n.label,
      meta: n.meta,
    })),
    edges: response.edges.map((e) => ({
      edge_id: e.edge_id,
      source: e.source,
      target: e.target,
      relation: e.relation,
      meta: {
        ...(e.meta ?? {}),
        qty: e.qty,
        unit: e.unit,
        proof_level: e.proof_level,
        effective_at: e.effective_at,
      },
    })),
    highlights: response.data_quality_issues
      .filter((i) => i.node_id !== null)
      .map((i) => ({
        node_id: i.node_id as string,
        code: i.code,
        level: i.level,
        message: i.message || DATA_QUALITY_LABELS[i.code],
      })),
    truncated: {
      maxDepthReached: response.truncated.depth_reached,
      maxNodesReached: response.truncated.node_budget_reached,
      maxEdgesReached: response.truncated.edge_budget_reached,
    },
  };
}
