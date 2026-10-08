import type { MarginCostInput } from "./margin-engine";

function ambiguous(input: MarginCostInput, reason: string): MarginCostInput {
  return {
    ...input,
    availability: "PROVIDED",
    valuation_issue: "COST_SOURCE_COLLISION",
    evidence: { ...input.evidence, source_reliability: "UNKNOWN",
      definition: `${input.evidence.definition} ${reason}` },
  };
}

/** Keep amounts and lineage inspectable, but never sum an ambiguous identity. */
export function guardCostInputIdentities(costs: readonly MarginCostInput[]): MarginCostInput[] {
  const counts = new Map<string, number>();
  for (const cost of costs) if (cost.availability === "PROVIDED") counts.set(cost.key, (counts.get(cost.key) ?? 0) + 1);
  return costs.map(cost => cost.availability === "PROVIDED" && (counts.get(cost.key) ?? 0) > 1 && !cost.valuation_issue
    ? ambiguous(cost, "Plusieurs coûts portent cette identité ; réconciliez leurs sources.") : cost);
}

/** Historical quote keys identify an economic row but not its commercial line.
 * Do not guess an allocation when that row occurs on one or several lines. */
export function composeMarginCostSources(automatic: readonly MarginCostInput[], manual: readonly MarginCostInput[],
  retiredAutomaticKeys: readonly string[] = []): MarginCostInput[] {
  const retired = new Set(retiredAutomaticKeys);
  const overlappingAutomatic = new Set<string>();
  const adjustedManual = manual.map(cost => {
    if (cost.availability === "NOT_APPLICABLE") return cost;
    const legacy = /^(purchase|operation):\d+$/.test(cost.key);
    const matches = legacy ? automatic.filter(source => source.key.startsWith("quote-line:")
      && source.key.endsWith(`:${cost.key}`)) : [];
    for (const match of matches) overlappingAutomatic.add(match.key);
    return matches.length || retired.has(cost.key)
      ? ambiguous(cost, "Cette ancienne identité recouvre une source automatique actuelle ; réconciliez l’entrée manuelle.")
      : cost;
  });
  const adjustedAutomatic = automatic.map(cost => overlappingAutomatic.has(cost.key)
    ? ambiguous(cost, "Cette source recouvre une ancienne entrée manuelle ; aucune allocation n’est déduite.") : cost);
  return guardCostInputIdentities([...adjustedAutomatic, ...adjustedManual]);
}
