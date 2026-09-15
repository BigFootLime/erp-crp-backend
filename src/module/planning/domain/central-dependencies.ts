import type { Dependency } from '../types/planning-central.types';

export function dependencyIndex(dependencies: Dependency[]) {
  const incoming = new Map<string, Dependency[]>(), outgoing = new Map<string, Dependency[]>();
  for (const edge of dependencies) {
    if (!incoming.has(edge.successorId)) incoming.set(edge.successorId, []);
    if (!outgoing.has(edge.predecessorId)) outgoing.set(edge.predecessorId, []);
    incoming.get(edge.successorId)!.push(edge);
    outgoing.get(edge.predecessorId)!.push(edge);
  }
  return { incoming, outgoing };
}

/** O(vertices + edges), including reverse-ordered chains. */
export function dependencyClosure(dependencies: Dependency[], seeds: string[], direction: 'downstream' | 'upstream' | 'both', max = 10000) {
  const { incoming, outgoing } = dependencyIndex(dependencies);
  const result = new Set(seeds), queue = [...result];
  if (result.size > max) throw new Error('PLANNING_CHAIN_TOO_DENSE');
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index];
    const next = [...(direction !== 'upstream' ? (outgoing.get(id) ?? []).map(e => e.successorId) : []),
      ...(direction !== 'downstream' ? (incoming.get(id) ?? []).map(e => e.predecessorId) : [])];
    for (const target of next) if (!result.has(target)) {
      result.add(target); queue.push(target);
      if (result.size > max) throw new Error('PLANNING_CHAIN_TOO_DENSE');
    }
  }
  return result;
}
