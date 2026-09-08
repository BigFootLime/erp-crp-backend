/** API v2: canonical business IDs, never copies of production/stock ledgers. */
export type CentralView = "global" | "machines" | "cutting" | "programming" | "external" | "internal";
export type Commitment = "FORECAST" | "COMMITTED" | "STARTED" | "DONE";
export type ResourceKind = "MACHINE" | "POSTE" | "PERSON" | "SUPPLIER";
export type Interval = { start: string; end: string };
export type Resource = {
  id: string; kind: ResourceKind; label: string; timezone: string;
  /** A machine and its linked workstations share the same physical capacity. */
  capacityId?: string;
  /** Explicit UTC intervals obtained from the resource's local civil calendar. */
  availability: Interval[]; qualifiedTaskIds?: string[]; version: string;
};
export type Dependency = {
  predecessorId: string; successorId: string; transferQuantity: number | null;
  /** Already released for this successor, not merely reported good. */
  releasedQuantity: number; lagMinutes: number;
};
export type Estimate = {
  policy: string; setupMinutes: number; unitMinutes: number; remainingMinutes: number;
  provenance: "ROUTING" | "HISTORY" | "CURRENT"; confidence: "INITIAL" | "LIMITED" | "CONSOLIDATED";
  observations: number; dispersionMinutes: number | null; provisional: boolean;
  excluded: Array<{ id: string; reason: string }>;
};
export type CentralTask = {
  id: string; source: "OPERATION" | "PROGRAMMING" | "DRAFT";
  operationId: string | null; programmingId: string | null; ofId: number | null; orderId: number | null;
  ofNumber: string | null; reference: string; revision: string | null; label: string;
  view: Exclude<CentralView, "global" | "machines" | "internal"> | "machines";
  internal: boolean; internalPurpose: string | null; quantity: number;
  good: number; scrap: number; rework: number; released: number;
  resourceIds: string[]; eligibleResourceIds: string[];
  committed: Interval | null; forecast: Interval | null; actual: Partial<Interval> | null;
  commitment: Commitment; locked: boolean; readiness: "READY" | "DRAFT" | "MISSING";
  blockers: string[]; earliestStart: string | null; due: string | null;
  priority: number; createdAt: string; version: string; estimate: Estimate | null;
};
export type ScheduleChange = { taskId: string; before: Interval | null; beforeResourceIds?: string[]; after: Interval; resourceIds: string[] };
export type ScheduleConflict = { taskId: string; code: string; message: string; relatedTaskId?: string };
export type ScheduleResult = {
  changes: ScheduleChange[]; forecasts: Record<string, Interval>;
  conflicts: ScheduleConflict[]; feasible: boolean; affected: string[];
};
export type CoverageSource = {
  id: string; kind: "PHYSICAL" | "PURCHASE" | "PRODUCTION" | "FORECAST";
  articleId: string; revision: string | null; unit: string; contractId: string | null;
  quantity: number; usable: boolean; availableAt: string | null; version: string;
};
export type Demand = {
  id: string; articleId: string; compatibleRevisions: Array<string | null>; unit: string;
  contractId: string | null; quantity: number; due: string | null;
};
export type Allocation = {
  id: string; sourceId: string; demandId: string; quantity: number;
  /** Each transferred quantity is covered by a linked physical reservation. */
  transferredQuantity: number; cancelled: boolean;
};
export type CoverageProposal = {
  demandId: string; allocations: Array<{ sourceId: string; quantity: number; late: boolean; unsecured: boolean }>;
  existing: number; missing: number; risks: string[];
};
export type CentralSnapshot = {
  forecastState?: import('../repository/planning-forecast.repository').ForecastState;
  apiVersion: 2; revision: string; generatedAt: string; stale: boolean;
  activation: "OBSERVE" | "READ" | "SIMULATE" | "COMMIT" | "EXECUTE" | "LEARN";
  tasks: CentralTask[]; resources: Resource[]; dependencies: Dependency[];
  sources: CoverageSource[]; demands: Demand[]; allocations: Allocation[];
  total: number; nextCursor: string | null;
};
