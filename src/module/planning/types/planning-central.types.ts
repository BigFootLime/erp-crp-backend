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
  routingSetupMinutes?: number; routingUnitMinutes?: number; setupObservations?: number; learnedAt?: string | null;
  policy: string; setupMinutes: number; unitMinutes: number; remainingMinutes: number;
  provenance: "ROUTING" | "HISTORY" | "CURRENT"; confidence: "INITIAL" | "LIMITED" | "CONSOLIDATED";
  observations: number; dispersionMinutes: number | null; provisional: boolean;
  excluded: Array<{ id: string; reason: string }>;
};
export type CentralTask = {
  external?: { packages: import('../../subcontract/subcontract-flow.types').SubcontractFlow[]; fullReadyAt:string|null; firstBatchReadyAt:string|null; issues:string[] };
  resourceEstimates?: Record<string, Estimate>;
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
  /** Disjoint existing commitment slices, or net free supply after ALL OFs.
   * Free supply is shared evidence, never a new allocation or an additive OF total. */
  scope?: "ASSIGNED" | "FREE";
  state?: "PHYSICAL" | "EXPECTED" | "BLOCKED" | "DRAFT";
  label?: string; referenceId?: string; lineId?: string;
  ownerClientId?: string | null;
};
export type DemandCoverage = {
  ofId: number; operationId: string | null; sourceRef: string; label: string;
  kind: "MATERIAL";
  consumed: number; reserved: number; usableReserved: number; reservedBlocked: number;
  /** Existing module proposal: not reserved, not counted in the forecast. */
  stockAvailable: number;
  expected: number; receivedBlocked: number; draft: number;
  /** Still without any commitment; drafts and blocked receipts avoid duplicate buying. */
  missing: number; toPrepare: number;
  /** Includes draft/blocked commitments which cannot secure a start. */
  unsecured: number;
  availableAt: string | null; issues: string[]; sourceIds: string[];
};
export type Demand = {
  id: string; articleId: string; compatibleRevisions: Array<string | null>; unit: string;
  contractId: string | null; quantity: number; due: string | null;
  coverage?: DemandCoverage;
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
  learningState?: { calculated_at: string | null; last_error: string | null; pending: number; oldest_pending_at: string | null; processed_operations: string };
  forecastState?: import('../repository/planning-forecast.repository').ForecastState;
  apiVersion: 2; revision: string; generatedAt: string; stale: boolean;
  activation: "OBSERVE" | "READ" | "SIMULATE" | "COMMIT" | "EXECUTE" | "LEARN";
  tasks: CentralTask[]; resources: Resource[]; dependencies: Dependency[];
  sources: CoverageSource[]; demands: Demand[]; allocations: Allocation[];
  coverageAvailable: boolean;
  total: number; nextCursor: string | null;
};
