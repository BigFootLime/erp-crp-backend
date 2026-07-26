// Traçabilité industrielle 360 (#142) — moteur de graphe PUR, sans I/O.
//
// Le parcours se fait NIVEAU PAR NIVEAU et non nœud par nœud : à chaque
// profondeur, le moteur remet la frontière complète au repository, qui répond
// en une requête par type de nœud. C'est exactement ce qui supprime le N+1 du
// moteur historique (une requête par nœud visité, soit ~120 allers-retours pour
// une chaîne moyenne). Le nombre d'allers-retours devient O(profondeur), pas
// O(nœuds).
//
// Le moteur ne connaît ni PostgreSQL ni Express : il reçoit une fonction
// `fetchNeighbors` et un prédicat de visibilité. Il est donc testable seul, et
// la même logique sert `/chain`, `/expand` et `/impact`.

import {
  nodeKey,
  type DataQualityIssue,
  type EdgeDirection,
  type TraceabilityNodeRef,
  type TraceabilityNodeType,
  type TraceabilityProofLevel,
  type TraceabilityRelationType,
} from "./traceability-model";

/* -------------------------------------------------------------------------- */
/* 1) Arête brute produite par le repository                                  */
/* -------------------------------------------------------------------------- */

export type NeighborEdge = {
  /** Sens de parcours : amont (vers l'origine), aval (vers le client), ou latéral (preuve attachée). */
  direction: EdgeDirection;
  relation: TraceabilityRelationType;
  /**
   * Extrémité AMONT dans le flux industriel — TOUJOURS, quel que soit le sens
   * dans lequel l'arête a été découverte. Une arête se lit donc toujours dans
   * le sens de la matière, et les libellés n'ont pas à s'inverser.
   */
  from: TraceabilityNodeRef;
  /** Extrémité AVAL dans le flux industriel. */
  to: TraceabilityNodeRef;
  /** Comment cette relation est prouvée. Jamais deviné, jamais rapproché. */
  proof_level: TraceabilityProofLevel;
  /** Enregistrement source : table + colonne qui portent la preuve. */
  proof_source: string;
  effective_at: string | null;
  qty: number | null;
  unit: string | null;
  correlation_id: string | null;
  /** Identifiant opaque de l'enregistrement de preuve (jamais un chemin de fichier). */
  evidence_ref: string | null;
  /** Statut de l'objet AU MOMENT de la relation (≠ statut actuel). */
  historical_status: string | null;
  meta: Record<string, unknown> | null;
};

/**
 * Le nœud d'ANCRAGE est celui qu'on était en train de déplier ; le VOISIN est
 * celui qu'on découvre. Comme une arête est toujours stockée dans le sens du
 * flux (amont → aval), l'ancre est `to` en parcours amont et `from` sinon.
 */
export function anchorOf(edge: NeighborEdge): TraceabilityNodeRef {
  return edge.direction === "upstream" ? edge.to : edge.from;
}

export function neighborOf(edge: NeighborEdge): TraceabilityNodeRef {
  return edge.direction === "upstream" ? edge.from : edge.to;
}

export type GraphEdge = NeighborEdge & {
  edge_id: string;
  source: string;
  target: string;
  /** Profondeur (en arêtes) à laquelle l'arête a été découverte depuis le seed. */
  depth: number;
};

/* -------------------------------------------------------------------------- */
/* 2) Entrées / sorties du moteur                                             */
/* -------------------------------------------------------------------------- */

export type FetchNeighbors = (
  refs: TraceabilityNodeRef[],
  direction: "upstream" | "downstream"
) => Promise<NeighborEdge[]>;

export type ExpandOptions = {
  seeds: TraceabilityNodeRef[];
  directions: Array<"upstream" | "downstream">;
  maxDepth: number;
  maxNodes: number;
  maxEdges: number;
  maxNeighborsPerNode: number;
  fetchNeighbors: FetchNeighbors;
  /** Refus par défaut : un type non visible est retiré AVEC ses arêtes. */
  isVisible: (type: TraceabilityNodeType) => boolean;
  /** Types de nœuds retenus (filtre utilisateur). `null` = tous. */
  nodeTypeFilter?: ReadonlySet<TraceabilityNodeType> | null;
  /** Relations retenues (filtre utilisateur). `null` = toutes. */
  relationFilter?: ReadonlySet<TraceabilityRelationType> | null;
  /** Bornes de période appliquées aux arêtes datées. */
  periodFrom?: string | null;
  periodTo?: string | null;
};

export type BranchTruncation = {
  node_id: string;
  direction: EdgeDirection;
  reason: "neighbor_cap" | "node_budget" | "edge_budget" | "depth";
  dropped: number;
};

export type ExpandResult = {
  nodes: TraceabilityNodeRef[];
  edges: GraphEdge[];
  /** Chemin le plus court seed → nœud, en identifiants d'arêtes. */
  paths: Map<string, string[]>;
  depthByNode: Map<string, number>;
  truncated: {
    depth_reached: boolean;
    node_budget_reached: boolean;
    edge_budget_reached: boolean;
    branches: BranchTruncation[];
  };
  coverage: {
    visited_nodes: number;
    expanded_nodes: number;
    frontier_pending: number;
    hidden_by_permission: number;
    filtered_out: number;
  };
  issues: DataQualityIssue[];
};

/* -------------------------------------------------------------------------- */
/* 3) Identité d'arête                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Une arête est identifiée par (source, cible, relation, enregistrement de
 * preuve). Inclure `evidence_ref` est indispensable : deux consommations du
 * MÊME lot par le MÊME OF à deux dates sont deux faits distincts, pas un
 * doublon à écraser. Le moteur historique les fusionnait et perdait la
 * quantité réelle.
 */
export function makeEdgeId(edge: NeighborEdge): string {
  const src = nodeKey(edge.from);
  const tgt = nodeKey(edge.to);
  const ev = edge.evidence_ref ? `@${edge.evidence_ref}` : "";
  return `${src}=>${tgt}#${edge.relation}${ev}`;
}

/* -------------------------------------------------------------------------- */
/* 4) Filtres de période                                                      */
/* -------------------------------------------------------------------------- */

function edgeWithinPeriod(
  edge: NeighborEdge,
  from: string | null | undefined,
  to: string | null | undefined
): boolean {
  if (!from && !to) return true;
  // Une arête sans date n'est PAS écartée : l'absence de date est une lacune de
  // données, pas une preuve d'exclusion. On la garde et on la signale.
  if (!edge.effective_at) return true;
  const t = Date.parse(edge.effective_at);
  if (Number.isNaN(t)) return true;
  if (from) {
    const f = Date.parse(from);
    if (!Number.isNaN(f) && t < f) return false;
  }
  if (to) {
    const e = Date.parse(to);
    if (!Number.isNaN(e) && t > e) return false;
  }
  return true;
}

/* -------------------------------------------------------------------------- */
/* 5) Parcours                                                                */
/* -------------------------------------------------------------------------- */

export async function expandGraph(options: ExpandOptions): Promise<ExpandResult> {
  const {
    seeds,
    directions,
    maxDepth,
    maxNodes,
    maxEdges,
    maxNeighborsPerNode,
    fetchNeighbors,
    isVisible,
  } = options;

  const nodeTypeFilter = options.nodeTypeFilter ?? null;
  const relationFilter = options.relationFilter ?? null;

  const visited = new Set<string>();
  const nodes: TraceabilityNodeRef[] = [];
  const depthByNode = new Map<string, number>();
  const parentEdge = new Map<string, string>();
  const parentNode = new Map<string, string>();

  const edges: GraphEdge[] = [];
  const edgeIds = new Set<string>();
  const branches: BranchTruncation[] = [];
  const issues: DataQualityIssue[] = [];

  let hiddenByPermission = 0;
  let filteredOut = 0;
  let nodeBudgetReached = false;
  let edgeBudgetReached = false;
  let depthReached = false;
  let expandedNodes = 0;
  let cycleReported = false;

  // Les seeds invisibles ne rentrent jamais dans le graphe : c'est la garde
  // d'entrée. Le contrôleur a déjà refusé l'appel, ceci est la ceinture.
  const frontierStart: TraceabilityNodeRef[] = [];
  for (const seed of seeds) {
    const key = nodeKey(seed);
    if (visited.has(key)) continue;
    if (!isVisible(seed.type)) {
      hiddenByPermission += 1;
      continue;
    }
    visited.add(key);
    nodes.push(seed);
    depthByNode.set(key, 0);
    frontierStart.push(seed);
  }

  let frontier = frontierStart;

  for (let depth = 0; depth < maxDepth; depth += 1) {
    if (frontier.length === 0) break;
    if (nodeBudgetReached || edgeBudgetReached) {
      depthReached = true;
      break;
    }

    // ── Un aller-retour par direction et par NIVEAU (pas par nœud) ──────────
    const batches = await Promise.all(
      directions.map((direction) => fetchNeighbors(frontier, direction))
    );

    const raw: NeighborEdge[] = [];
    for (const batch of batches) raw.push(...batch);

    // Regroupement par (nœud d'ancrage, direction) pour appliquer le plafond de
    // voisins branche par branche et signaler CE qui a été coupé.
    const grouped = new Map<string, NeighborEdge[]>();
    for (const edge of raw) {
      const gk = `${nodeKey(anchorOf(edge))}|${edge.direction}`;
      const arr = grouped.get(gk);
      if (arr) arr.push(edge);
      else grouped.set(gk, [edge]);
    }

    const nextFrontier: TraceabilityNodeRef[] = [];

    for (const [gk, groupEdges] of grouped) {
      const [anchorKey, anchorDirection] = gk.split("|") as [string, EdgeDirection];
      expandedNodes += 1;

      // Filtres utilisateur AVANT le plafond : sinon on couperait des voisins
      // que l'utilisateur a explicitement demandés au profit d'autres.
      const kept: NeighborEdge[] = [];
      for (const edge of groupEdges) {
        if (relationFilter && !relationFilter.has(edge.relation)) {
          filteredOut += 1;
          continue;
        }
        if (nodeTypeFilter && !nodeTypeFilter.has(neighborOf(edge).type)) {
          filteredOut += 1;
          continue;
        }
        if (!edgeWithinPeriod(edge, options.periodFrom, options.periodTo)) {
          filteredOut += 1;
          continue;
        }
        if (!isVisible(neighborOf(edge).type)) {
          // Le nœud interdit disparaît AVEC son arête : aucune inférence
          // possible sur son existence depuis la relation.
          hiddenByPermission += 1;
          continue;
        }
        kept.push(edge);
      }

      let slice = kept;
      if (kept.length > maxNeighborsPerNode) {
        slice = kept.slice(0, maxNeighborsPerNode);
        branches.push({
          node_id: anchorKey,
          direction: anchorDirection,
          reason: "neighbor_cap",
          dropped: kept.length - maxNeighborsPerNode,
        });
      }

      let droppedForNodeBudget = 0;
      let droppedForEdgeBudget = 0;

      for (const edge of slice) {
        if (edges.length >= maxEdges) {
          edgeBudgetReached = true;
          droppedForEdgeBudget += 1;
          continue;
        }

        const edgeId = makeEdgeId(edge);
        const neighbor = neighborOf(edge);
        const neighborKey = nodeKey(neighbor);
        const isNewNode = !visited.has(neighborKey);

        if (isNewNode && nodes.length >= maxNodes) {
          // On n'ajoute pas une arête vers un nœud qu'on ne peut pas décrire :
          // une arête pendante est une relation orpheline pour l'UI.
          nodeBudgetReached = true;
          droppedForNodeBudget += 1;
          continue;
        }

        if (!edgeIds.has(edgeId)) {
          edgeIds.add(edgeId);
          edges.push({
            ...edge,
            edge_id: edgeId,
            source: nodeKey(edge.from),
            target: nodeKey(edge.to),
            depth: depth + 1,
          });
        }

        if (isNewNode) {
          visited.add(neighborKey);
          nodes.push(neighbor);
          depthByNode.set(neighborKey, depth + 1);
          parentEdge.set(neighborKey, edgeId);
          parentNode.set(neighborKey, anchorKey);
          nextFrontier.push(neighbor);
        } else if (!cycleReported && isAncestor(parentNode, anchorKey, neighborKey)) {
          // Un cycle est une anomalie industrielle réelle (un lot ne peut pas
          // se consommer lui-même). On le SIGNALE et on ne ré-expanse pas :
          // le parcours reste borné, l'anomalie remonte au métier.
          cycleReported = true;
          issues.push({
            code: "CYCLE_DETECTED",
            level: "warning",
            node_id: neighborKey,
            message: "Un cycle a été détecté dans la généalogie : le parcours a été borné.",
            details: { via_edge: edgeId },
          });
        }
      }

      if (droppedForNodeBudget > 0) {
        branches.push({
          node_id: anchorKey,
          direction: anchorDirection,
          reason: "node_budget",
          dropped: droppedForNodeBudget,
        });
      }
      if (droppedForEdgeBudget > 0) {
        branches.push({
          node_id: anchorKey,
          direction: anchorDirection,
          reason: "edge_budget",
          dropped: droppedForEdgeBudget,
        });
      }
    }

    frontier = nextFrontier;
    if (frontier.length > 0 && depth + 1 >= maxDepth) depthReached = true;
  }

  if (frontier.length > 0) depthReached = true;

  if (depthReached || nodeBudgetReached || edgeBudgetReached || branches.length > 0) {
    issues.push({
      code: "TRUNCATED_BY_LIMITS",
      level: "info",
      node_id: null,
      message:
        "Le graphe est partiel : élargissez la profondeur, filtrez par type ou dépliez une branche.",
      details: {
        depth_reached: depthReached,
        node_budget_reached: nodeBudgetReached,
        edge_budget_reached: edgeBudgetReached,
        branches: branches.length,
      },
    });
  }

  if (hiddenByPermission > 0) {
    issues.push({
      code: "TRUNCATED_BY_PERMISSIONS",
      level: "info",
      node_id: null,
      message: `${hiddenByPermission} élément(s) ne vous sont pas accessibles et ont été retirés de la chaîne.`,
      details: { hidden: hiddenByPermission },
    });
  }

  return {
    nodes,
    edges,
    paths: buildPaths(nodes, parentEdge, parentNode),
    depthByNode,
    truncated: {
      depth_reached: depthReached,
      node_budget_reached: nodeBudgetReached,
      edge_budget_reached: edgeBudgetReached,
      branches,
    },
    coverage: {
      visited_nodes: nodes.length,
      expanded_nodes: expandedNodes,
      frontier_pending: frontier.length,
      hidden_by_permission: hiddenByPermission,
      filtered_out: filteredOut,
    },
    issues,
  };
}

/* -------------------------------------------------------------------------- */
/* 6) Chemins de preuve                                                       */
/* -------------------------------------------------------------------------- */

function isAncestor(
  parentNode: Map<string, string>,
  fromKey: string,
  candidateAncestor: string
): boolean {
  let cursor: string | undefined = fromKey;
  let guard = 0;
  while (cursor && guard < 64) {
    if (cursor === candidateAncestor) return true;
    cursor = parentNode.get(cursor);
    guard += 1;
  }
  return false;
}

/**
 * Chemin le plus court seed → nœud. C'est le « chemin de preuve » affiché dans
 * le panneau de détail et exigé par chaque item d'analyse d'impact : sans lui,
 * un impact annoncé n'est qu'une affirmation.
 */
export function buildPaths(
  nodes: TraceabilityNodeRef[],
  parentEdge: Map<string, string>,
  parentNode: Map<string, string>
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const node of nodes) {
    const key = nodeKey(node);
    const path: string[] = [];
    let cursor: string | undefined = key;
    let guard = 0;
    while (cursor && guard < 64) {
      const edgeId = parentEdge.get(cursor);
      if (!edgeId) break;
      path.unshift(edgeId);
      cursor = parentNode.get(cursor);
      guard += 1;
    }
    out.set(key, path);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* 7) Résumé                                                                  */
/* -------------------------------------------------------------------------- */

export function summarizeByType(
  nodes: TraceabilityNodeRef[]
): Array<{ type: TraceabilityNodeType; count: number }> {
  const counts = new Map<TraceabilityNodeType, number>();
  for (const n of nodes) counts.set(n.type, (counts.get(n.type) ?? 0) + 1);
  return Array.from(counts.entries())
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
}

export function summarizeProof(
  edges: GraphEdge[]
): Record<TraceabilityProofLevel, number> {
  const out: Record<TraceabilityProofLevel, number> = { proven: 0, declared: 0, unknown: 0 };
  for (const e of edges) out[e.proof_level] += 1;
  return out;
}
