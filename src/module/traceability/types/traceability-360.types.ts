// Traçabilité industrielle 360 (#142) — contrat de sortie de l'API.
//
// Aucun de ces types ne porte `storage_path`, chemin serveur, jeton, URL signée
// permanente ni donnée personnelle non nécessaire. Un document est identifié
// par son `id` opaque et son empreinte, jamais par son emplacement disque.

import type {
  DataQualityIssue,
  ImpactClassification,
  TraceabilityDirection,
  TraceabilityNodeType,
  TraceabilityProofLevel,
  TraceabilityRelationType,
} from "../domain/traceability-model";
import type { TraceabilityCapability } from "../domain/traceability-policy";
import type { TraceabilityNodeDTO } from "../repository/traceability-hydrate.repository";
import type { TraceabilitySearchHit } from "../repository/traceability-search.repository";

export type { TraceabilityNodeDTO, TraceabilitySearchHit };

export type TraceabilityEdgeDTO = {
  edge_id: string;
  source: string;
  target: string;
  relation: TraceabilityRelationType;
  relation_label: string;
  relation_inverse_label: string;
  direction: "upstream" | "downstream" | "lateral";
  depth: number;
  proof_level: TraceabilityProofLevel;
  proof_label: string;
  /** Table + colonne qui portent la preuve. Jamais un chemin de fichier. */
  proof_source: string;
  /** Identifiant opaque de l'enregistrement de preuve. */
  evidence_ref: string | null;
  effective_at: string | null;
  qty: number | null;
  unit: string | null;
  correlation_id: string | null;
  /** Statut de l'objet AU MOMENT de la relation. */
  historical_status: string | null;
  meta: Record<string, unknown> | null;
};

export type TraceabilityScope = {
  direction: TraceabilityDirection;
  max_depth: number;
  max_nodes: number;
  max_edges: number;
  node_types: TraceabilityNodeType[] | null;
  relations: TraceabilityRelationType[] | null;
  period_from: string | null;
  period_to: string | null;
};

export type TraceabilityCoverage = {
  complete: boolean;
  visited_nodes: number;
  expanded_nodes: number;
  frontier_pending: number;
  hidden_by_permission: number;
  filtered_out: number;
  proof_levels: Record<TraceabilityProofLevel, number>;
  /** État global lisible : complet, partiel, bloqué, incomplet, anomalie. */
  state: "COMPLETE" | "PARTIAL" | "PERMISSION_LIMITED" | "HISTORICALLY_INCOMPLETE" | "INTEGRITY_ISSUE";
  state_label: string;
};

export type TraceabilityTruncation = {
  depth_reached: boolean;
  node_budget_reached: boolean;
  edge_budget_reached: boolean;
  branches: Array<{
    node_id: string;
    direction: "upstream" | "downstream" | "lateral";
    reason: "neighbor_cap" | "node_budget" | "edge_budget" | "depth";
    dropped: number;
  }>;
};

export type TraceabilitySummaryEntry = { type: TraceabilityNodeType; label: string; count: number };

export type TraceabilityChainResponse = {
  seed: TraceabilityNodeDTO;
  as_of: string;
  generated_at: string;
  scope: TraceabilityScope;
  capabilities: Record<TraceabilityCapability, boolean>;
  nodes: TraceabilityNodeDTO[];
  edges: TraceabilityEdgeDTO[];
  /** Chemin de preuve le plus court seed → nœud, en identifiants d'arête. */
  paths: Record<string, string[]>;
  summary: {
    by_type: TraceabilitySummaryEntry[];
    node_count: number;
    edge_count: number;
    upstream_count: number;
    downstream_count: number;
  };
  coverage: TraceabilityCoverage;
  data_quality_issues: DataQualityIssue[];
  /** Tables autoritaires réellement interrogées pour construire cette chaîne. */
  sources: string[];
  truncated: TraceabilityTruncation;
  next_cursor: string | null;
};

export type TraceabilitySearchResponse = {
  term: string;
  hits: TraceabilitySearchHit[];
  has_more: boolean;
  limit: number;
  offset: number;
  searched_types: TraceabilityNodeType[];
  capabilities: Record<TraceabilityCapability, boolean>;
};

export type TraceabilityImpactItem = {
  node: TraceabilityNodeDTO;
  classification: ImpactClassification;
  classification_label: string;
  /** Chemin de preuve complet : sans lui, un impact n'est qu'une affirmation. */
  proof_path: TraceabilityEdgeDTO[];
  weakest_proof: TraceabilityProofLevel;
  reason: string;
  qty: number | null;
  unit: string | null;
  date: string | null;
};

export type TraceabilityImpactResponse = {
  seed: TraceabilityNodeDTO;
  as_of: string;
  generated_at: string;
  scope: TraceabilityScope & { since: string | null };
  /**
   * Rappel explicite porté par la réponse : cette opération est en LECTURE
   * SEULE. Elle ne bloque aucun stock, ne rappelle aucun produit, ne contacte
   * aucun client, n'annule aucun BL, ne crée aucun avoir, ne clôture aucune NC
   * et ne modifie aucun OF. Toute action passe par le module autoritaire.
   */
  read_only: true;
  items: TraceabilityImpactItem[];
  counts: Record<ImpactClassification, number>;
  coverage: TraceabilityCoverage;
  data_quality_issues: DataQualityIssue[];
  truncated: TraceabilityTruncation;
};
