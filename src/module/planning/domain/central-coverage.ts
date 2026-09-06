import type { Allocation, CoverageProposal, CoverageSource, Demand } from "../types/planning-central.types";
const EPS = 0.000001;
const round = (n: number) => Math.round(n * 1e6) / 1e6;
export function outstanding(a: Allocation): number {
  if (!Number.isFinite(a.quantity) || !Number.isFinite(a.transferredQuantity) ||
      a.quantity < 0 || a.transferredQuantity < 0 || a.transferredQuantity > a.quantity + EPS) throw new Error("INVALID_ALLOCATION");
  return a.cancelled ? 0 : round(Math.max(0, a.quantity - a.transferredQuantity));
}
export function sourceAvailable(source: CoverageSource, allocations: Allocation[]): number {
  if (!Number.isFinite(source.quantity) || source.quantity < 0) throw new Error("INVALID_SUPPLY");
  const assigned = allocations.filter(a => a.sourceId === source.id).reduce((s, a) => s + outstanding(a), 0);
  return round(source.quantity - assigned);
}
/** Pure proposal. Existing commitments are preserved even if a source becomes late or quarantined. */
export function proposeCoverage(demands: Demand[], sources: CoverageSource[], allocations: Allocation[]): CoverageProposal[] {
  const available = new Map(sources.map(s => [s.id, sourceAvailable(s, allocations)]));
  const rank = { PHYSICAL: 0, PURCHASE: 1, PRODUCTION: 1, FORECAST: 2 };
  const candidates = [...sources].sort((a, b) => rank[a.kind] - rank[b.kind] ||
    (a.availableAt ?? "9999").localeCompare(b.availableAt ?? "9999") || a.id.localeCompare(b.id));
  return [...demands].sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999") || a.id.localeCompare(b.id)).map(d => {
    if (!Number.isFinite(d.quantity) || d.quantity < 0) throw new Error("INVALID_DEMAND");
    const existingAllocations = allocations.filter(a => a.demandId === d.id && !a.cancelled);
    // Only outstanding future portions plus the canonical physical reservations count.
    const existing = round(existingAllocations.reduce((sum, a) => sum + outstanding(a), 0));
    const risks: string[] = [];
    for (const a of existingAllocations) {
      const s = sources.find(s => s.id === a.sourceId);
      if (outstanding(a) && (!s || !s.usable)) risks.push("EXISTING_SOURCE_UNAVAILABLE:" + a.sourceId);
      if (s?.availableAt && d.due && s.availableAt > d.due) risks.push("LATE:" + s.id);
    }
    let missing = Math.max(0, round(d.quantity - existing));
    const proposals: CoverageProposal["allocations"] = [];
    for (const s of candidates) {
      if (missing <= EPS) break;
      if (!s.usable || s.articleId !== d.articleId || !d.compatibleRevisions.includes(s.revision) || s.unit !== d.unit ||
          (s.contractId !== null && s.contractId !== d.contractId)) continue;
      // Unknown dates are visible risks, never a promise of timely coverage.
      const quantity = round(Math.min(missing, Math.max(0, available.get(s.id) ?? 0)));
      if (quantity <= EPS) continue;
      const late = !s.availableAt || !!(d.due && s.availableAt > d.due);
      if (!s.availableAt) risks.push("AVAILABILITY_DATE_MISSING:" + s.id);
      proposals.push({ sourceId: s.id, quantity, late, unsecured: s.kind === "FORECAST" });
      available.set(s.id, round((available.get(s.id) ?? 0) - quantity));
      missing = round(missing - quantity);
    }
    return { demandId: d.id, existing, allocations: proposals, missing, risks };
  });
}

