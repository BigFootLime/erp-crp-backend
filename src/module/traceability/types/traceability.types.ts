export type TraceabilityNodeType =
  | "devis"
  | "commande"
  | "affaire"
  | "of"
  | "lot"
  | "bon_livraison"
  | "non_conformity"

export type TraceabilityNodeRef = {
  type: TraceabilityNodeType
  id: string
}

export type TraceabilityNodeId = string

export type TraceabilityNode = {
  node_id: TraceabilityNodeId
  type: TraceabilityNodeType
  id: string
  label: string
  meta: Record<string, unknown> | null
}

export type TraceabilityEdge = {
  edge_id: string
  source: TraceabilityNodeId
  target: TraceabilityNodeId
  relation: string
  meta: Record<string, unknown> | null
}

export type TraceabilityHighlight = {
  node_id: TraceabilityNodeId
  code: string
  level: "info" | "warning" | "danger"
  message: string
}

export type TraceabilityChainResult = {
  seed: TraceabilityNodeRef
  nodes: TraceabilityNode[]
  edges: TraceabilityEdge[]
  highlights: TraceabilityHighlight[]
  truncated: {
    maxDepthReached: boolean
    maxNodesReached: boolean
    maxEdgesReached: boolean
  }
}
