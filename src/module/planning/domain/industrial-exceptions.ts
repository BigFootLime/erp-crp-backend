import type {
  IndustrialInput,
  IndustrialResult,
} from "../types/industrial-plan.types";

/** Alternatives to a planned order. They are never an additional receipt in the net calculation. */
export function industrialExceptions(
  source: IndustrialInput,
  result: IndustrialResult,
) {
  const needs = new Map(source.demand.map((d) => [d.id, d])),
    used = new Map<string, number>();
  for (const allocation of result.allocations)
    used.set(
      allocation.source_id,
      (used.get(allocation.source_id) ?? 0) + allocation.quantity,
    );
  const suggestions: {
    action: "ADVANCE" | "POSTPONE_REVIEW" | "GROUP_REVIEW";
    article_id: string;
    source_ids: string[];
    quantity: number;
    date: string;
    reason: string;
  }[] = [];
  for (const p of result.proposals) {
    let missing = p.quantity;
    for (const s of source.supplies
      .filter(
        (s) =>
          s.kind !== "STOCK" &&
          s.article === p.article_id &&
          s.unit === p.unit &&
          s.available > p.due,
      )
      .sort(
        (a, b) =>
          a.available.localeCompare(b.available) || a.id.localeCompare(b.id),
      )) {
      if (
        s.orderLine &&
        !p.source_ids.some((id) => needs.get(id)?.orderLine === s.orderLine)
      )
        continue;
      if (s.contractLine && s.contractLine !== p.contract_line_id) continue;
      const free = Math.max(0, Number(s.quantity) - (used.get(s.id) ?? 0)),
        amount = Math.min(missing, free);
      if (!amount) continue;
      suggestions.push({
        action: "ADVANCE",
        article_id: p.article_id,
        source_ids: [s.id, ...p.source_ids],
        quantity: amount,
        date: p.due,
        reason:
          "Confirmer un avancement de la réception du " +
          s.available +
          " avant de créer une nouvelle fourniture.",
      });
      used.set(s.id, (used.get(s.id) ?? 0) + amount);
      missing -= amount;
      if (!missing) break;
    }
  }
  for (const s of source.supplies) {
    if (s.kind === "STOCK" || s.orderLine || s.contractLine) continue;
    const excess = Number(s.quantity) - (used.get(s.id) ?? 0);
    if (excess > 0)
      suggestions.push({
        action: "POSTPONE_REVIEW",
        article_id: s.article,
        source_ids: [s.id],
        quantity: excess,
        date: s.available,
        reason:
          "Quantité future libre sur cet horizon. Vérifier stocks cibles, conditions d’annulation et autres clients avant tout report.",
      });
  }
  const groups = new Map<string, typeof result.proposals>();
  for (const p of result.proposals) {
    const key = JSON.stringify([
      p.article_id,
      p.due,
      p.contract_line_id,
      p.unit,
    ]);
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  for (const group of groups.values())
    if (group.length > 1)
      suggestions.push({
        action: "GROUP_REVIEW",
        article_id: group[0].article_id,
        source_ids: [...new Set(group.flatMap((p) => p.source_ids))],
        quantity: group.reduce((sum, p) => sum + p.quantity, 0),
        date: group[0].due,
        reason:
          "Même article, échéance et propriétaire de réserve. Recalculer le lot après regroupement.",
      });
  return suggestions;
}
