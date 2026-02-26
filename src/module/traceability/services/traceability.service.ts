import type { TraceabilityChainResult, TraceabilityEdge, TraceabilityNodeRef } from "../types/traceability.types"

import {
  makeEdge,
  repoComputeHighlights,
  repoHydrateNodes,
  repoListHardNeighbors,
  repoListTraceabilityLinks,
} from "../repository/traceability.repository"

type ExpandLimits = {
  maxDepth: number
  maxNodes: number
  maxEdges: number
}

function nodeKey(ref: TraceabilityNodeRef): string {
  return `${ref.type}:${ref.id}`
}

export async function svcGetTraceabilityChain(params: {
  seed: TraceabilityNodeRef
  limits: ExpandLimits
}): Promise<TraceabilityChainResult> {
  const visited = new Set<string>()
  const nodes: TraceabilityNodeRef[] = []
  const edges: TraceabilityEdge[] = []
  const edgeKeys = new Set<string>()

  visited.add(nodeKey(params.seed))
  nodes.push(params.seed)

  let maxNodesReached = false
  let maxEdgesReached = false
  let maxDepthReached = false

  const work: Array<{ ref: TraceabilityNodeRef; depth: number }> = [{ ref: params.seed, depth: 0 }]

  while (work.length) {
    const item = work.shift()!

    if (item.depth >= params.limits.maxDepth) {
      maxDepthReached = true
      continue
    }

    const hard = await repoListHardNeighbors(item.ref)
    const linked = await repoListTraceabilityLinks(item.ref)
    const neighbors = [...hard, ...linked]

    for (const n of neighbors) {
      if (edges.length >= params.limits.maxEdges) {
        maxEdgesReached = true
        break
      }

      const e = makeEdge({ source: item.ref, target: n.ref, relation: n.relation, meta: n.meta ?? null })
      if (!edgeKeys.has(e.edge_id)) {
        edgeKeys.add(e.edge_id)
        edges.push(e)
      }

      const k = nodeKey(n.ref)
      if (!visited.has(k)) {
        if (nodes.length >= params.limits.maxNodes) {
          maxNodesReached = true
          continue
        }
        visited.add(k)
        nodes.push(n.ref)
        work.push({ ref: n.ref, depth: item.depth + 1 })
      }
    }

    if (maxEdgesReached) break
  }

  const hydrated = await repoHydrateNodes(nodes)
  const highlights = await repoComputeHighlights(nodes)

  return {
    seed: params.seed,
    nodes: Array.from(hydrated.values()),
    edges,
    highlights,
    truncated: {
      maxDepthReached,
      maxNodesReached,
      maxEdgesReached,
    },
  }
}
