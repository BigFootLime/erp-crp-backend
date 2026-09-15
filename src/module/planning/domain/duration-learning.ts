import { createHash } from "node:crypto";
import { centralCanonicalJson } from "./central-canonical-json";

export type DurationContext = {
  pieceId: string; revision: string; phase: number; machineId: string; configuration: string;
};
export function durationContextKey(context: DurationContext): string {
  return `duration-v2:${createHash("sha256").update(centralCanonicalJson(context)).digest("hex")}`;
}
export type LearningSegment = {
  id: string; start: string; end: string | null; status: string; validated: boolean; rejected: boolean;
  context: DurationContext | null; bucket: "SETUP" | "PRODUCTION" | "EXCLUDED" | "UNKNOWN";
  replaced: boolean; correctsId?: string | null; updatedAt: string;
};
export type LearningQuantity = {
  id: string; pointageId: string | null; good: number; scrap: number; rework: number; pending: number;
  declaredAt: string;
};
export type LearningSource = {
  operationId: string; status: string; cancelled: boolean; completedAt: string | null;
  context: DurationContext | null; segments: LearningSegment[]; quantities: LearningQuantity[];
  legacyUnmapped: boolean;
};
export type LearningObservation = {
  operationId: string; contextKey: string; context: DurationContext | null;
  productiveMinutes: number; quantity: number; setupMinutes: number | null;
  validated: boolean; excludedReason: string | null; recordedAt: string;
  sourceRevision: string; pointageIds: string[]; declarationIds: string[];
  current: { productiveMinutes: number; attributableQuantity: number } | null;
  setupCompletedMinutes: number;
};

/** Measure elapsed machine time, never the sum of simultaneous operator time. */
export function unionMinutes(segments: Pick<LearningSegment, "start" | "end">[]): number {
  const intervals = segments.map(s => [Date.parse(s.start), Date.parse(s.end ?? "")])
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start)
    .sort((a, b) => a[0] - b[0]);
  let end = -Infinity, milliseconds = 0;
  for (const [start, nextEnd] of intervals) {
    milliseconds += Math.max(0, nextEnd - Math.max(start, end));
    end = Math.max(end, nextEnd);
  }
  return milliseconds / 60_000;
}

export function buildDurationObservation(source: LearningSource): LearningObservation {
  const active = source.segments.filter(s => !s.replaced && s.status !== "CANCELLED" && s.status !== "CORRECTED");
  const relevant = active.filter(s => s.bucket !== "EXCLUDED");
  const production = relevant.filter(s => s.bucket === "PRODUCTION");
  const setup = relevant.filter(s => s.bucket === "SETUP");
  const contexts = new Map(relevant.filter(s => s.context).map(s => [durationContextKey(s.context!), s.context!]));
  const context = contexts.size === 1 ? [...contexts.values()][0] : source.context;
  const totals = source.quantities.reduce((a, q) => ({good:a.good+q.good,scrap:a.scrap+q.scrap,
    rework:a.rework+q.rework,pending:a.pending+q.pending}), {good:0,scrap:0,rework:0,pending:0});
  const successors = new Map(source.segments.filter(s => s.correctsId).map(s => [s.correctsId!, s.id]));
  const resolvePointage = (id: string | null) => {
    const visited = new Set<string>();
    while (id && successors.has(id) && !visited.has(id)) { visited.add(id); id = successors.get(id)!; }
    return id;
  };
  const quantityBySegment = new Map<string, number>();
  for (const q of source.quantities) {
    const id = resolvePointage(q.pointageId);
    if (id) quantityBySegment.set(id, (quantityBySegment.get(id) ?? 0) + q.good + q.scrap);
  }
  const productiveIds = new Set(production.map(s => s.id));
  let reason: string | null = null;
  if (source.cancelled) reason = "CANCELLED";
  else if (!context || relevant.some(s => !s.context)) reason = "CONTEXT_MISSING";
  else if (contexts.size > 1) reason = "MULTIPLE_CONTEXTS";
  else if (source.legacyUnmapped || relevant.some(s => s.bucket === "UNKNOWN")) reason = "LEGACY_MIXED_MEASUREMENT";
  else if (Object.values(totals).some(n => !Number.isFinite(n) || n < 0) || totals.rework !== 0 || totals.pending !== 0)
    reason = "AMBIGUOUS_QUANTITY";
  else if ([...quantityBySegment].some(([id, quantity]) => quantity < 0 || (quantity !== 0 && !productiveIds.has(id))))
    reason = "QUANTITY_WITHOUT_PRODUCTIVE_SEGMENT";
  else if (relevant.some(s => s.end && (!Number.isFinite(Date.parse(s.start)) ||
    !Number.isFinite(Date.parse(s.end)) || Date.parse(s.end) <= Date.parse(s.start) || Date.parse(s.end)-Date.parse(s.start)>86400000)))
    reason = "INVALID_INTERVAL";
  else if (production.some(p => setup.some(s => s.end && p.end && Date.parse(p.start)<Date.parse(s.end) && Date.parse(s.start)<Date.parse(p.end))))
    reason = "OVERLAPPING_ACTIVITIES";
  const productiveMinutes = unionMinutes(production);
  const setupMinutes = setup.length && setup.every(s => s.end) ? unionMinutes(setup) : null;
  const quantity = totals.good + totals.scrap;
  // Only an explicitly linked, closed set of segments can adjust the current run.
  const closed = production.filter(s => s.end && !s.rejected);
  const closedIds = new Set(closed.map(s => s.id));
  const attributable = source.quantities.filter(q => { const id = resolvePointage(q.pointageId); return id && closedIds.has(id); });
  const attributedIds = new Set(attributable.map(q => resolvePointage(q.pointageId)));
  const currentQuantity = attributable.reduce((n, q) => n + q.good + q.scrap, 0);
  const current = !reason && closed.length && closed.every(s => attributedIds.has(s.id)) && currentQuantity > 0
    ? {productiveMinutes:unionMinutes(closed),attributableQuantity:currentQuantity} : null;
  if (!reason && (source.status !== "DONE" || relevant.some(s => !s.end))) reason = "OPERATION_NOT_COMPLETE";
  if (!reason && relevant.some(s => !s.validated || s.rejected)) reason = "NOT_VALIDATED";
  if (!reason && (productiveMinutes <= 0 || quantity <= 0)) reason = "UNATTRIBUTABLE_QUANTITY_OR_TIME";
  return {
    operationId:source.operationId, context, contextKey:context ? durationContextKey(context) : `unattributable:${source.operationId}`,
    productiveMinutes,quantity,setupMinutes,validated:reason===null,excludedReason:reason,
    recordedAt:source.completedAt ?? source.segments.map(s => s.end ?? s.start).sort().at(-1) ?? "1970-01-01T00:00:00.000Z",
    sourceRevision:createHash("sha256").update(centralCanonicalJson({...source,
      segments:[...source.segments].sort((a,b)=>a.id.localeCompare(b.id)),
      quantities:[...source.quantities].sort((a,b)=>a.id.localeCompare(b.id))})).digest("hex"),
    pointageIds:source.segments.map(s=>s.id).sort(),declarationIds:source.quantities.map(q=>q.id).sort(),
    current:source.status === "RUNNING" ? current : null,
    setupCompletedMinutes:!reason || reason==="NOT_VALIDATED" || reason==="OPERATION_NOT_COMPLETE" ? unionMinutes(setup.filter(s=>s.end&&!s.rejected)) : 0,
  };
}
