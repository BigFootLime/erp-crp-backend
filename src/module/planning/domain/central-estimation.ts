import type { Estimate } from "../types/planning-central.types";

export const ESTIMATION_POLICY = Object.freeze({
  version: "cerp-duration-v1", historyWindow: 20, historyPrior: 5, currentPriorPieces: 10,
  consolidatedObservations: 10,
});
export type DurationObservation = {
  id: string; contextKey: string; validated: boolean; recordedAt: string;
  productiveMinutes: number; quantity: number; setupMinutes: number | null;
  /** A reason disqualifies ambiguous, cancelled or legacy mixed measurements. */
  excludedReason?: string | null;
};
export function median(values: number[]): number | null {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b), m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}
export function estimateDuration(input: {
  contextKey: string; routingSetupMinutes: number; routingUnitMinutes: number;
  quantity: number; good: number; scrap: number; rework: number;
  setupCompletedMinutes?: number; observations: DurationObservation[];
  current?: { productiveMinutes: number; attributableQuantity: number };
}): Estimate {
  for (const n of [input.routingSetupMinutes, input.routingUnitMinutes, input.quantity, input.good,
    input.scrap, input.rework, input.setupCompletedMinutes ?? 0]) {
    if (!Number.isFinite(n) || n < 0) throw new Error("INVALID_ESTIMATION_INPUT");
  }
  const excluded: Estimate["excluded"] = [];
  const comparable = input.observations.filter(o => {
    const reason = o.excludedReason || (o.contextKey !== input.contextKey ? "DIFFERENT_CONTEXT" :
      !o.validated ? "NOT_VALIDATED" : !Number.isFinite(o.productiveMinutes) || o.productiveMinutes <= 0 ||
      !Number.isFinite(o.quantity) || o.quantity <= 0 ? "UNATTRIBUTABLE_QUANTITY_OR_TIME" : null);
    if (reason) { excluded.push({ id: o.id, reason }); return false; }
    return true;
  }).sort((a, b) => b.recordedAt.localeCompare(a.recordedAt) || a.id.localeCompare(b.id))
    .slice(0, ESTIMATION_POLICY.historyWindow);
  const units = comparable.map(o => o.productiveMinutes / o.quantity);
  const historical = median(units), count = units.length;
  const historyWeight = count / (count + ESTIMATION_POLICY.historyPrior);
  let unit = historical === null ? input.routingUnitMinutes :
    input.routingUnitMinutes * (1 - historyWeight) + historical * historyWeight;
  let provenance: Estimate["provenance"] = count ? "HISTORY" : "ROUTING";
  let provisional = false;
  const current = input.current;
  if (current && Number.isFinite(current.productiveMinutes) && current.productiveMinutes > 0 &&
      Number.isFinite(current.attributableQuantity) && current.attributableQuantity > 0) {
    const weight = current.attributableQuantity / (current.attributableQuantity + ESTIMATION_POLICY.currentPriorPieces);
    unit = unit * (1 - weight) + current.productiveMinutes / current.attributableQuantity * weight;
    provenance = "CURRENT"; provisional = true;
  }
  const historicalSetup = median(comparable.map(o => o.setupMinutes).filter((n): n is number => n !== null && Number.isFinite(n) && n >= 0));
  const setup = historicalSetup === null ? input.routingSetupMinutes :
    input.routingSetupMinutes * (1 - historyWeight) + historicalSetup * historyWeight;
  // Scrap completes processing of a physical piece; replacements need an explicit new authorization.
  const remainingPieces = Math.max(0, input.quantity - input.good - input.scrap);
  return {
    policy: ESTIMATION_POLICY.version, setupMinutes: setup, unitMinutes: unit,
    remainingMinutes: Math.max(0, setup - (input.setupCompletedMinutes ?? 0)) + (remainingPieces + input.rework) * unit,
    provenance, confidence: count >= ESTIMATION_POLICY.consolidatedObservations ? "CONSOLIDATED" : count ? "LIMITED" : "INITIAL",
    observations: count, dispersionMinutes: historical === null ? null : median(units.map(v => Math.abs(v - historical))),
    provisional, excluded,
  };
}

