import type { AuditContext } from "../../methodes/types/methodes.types";

export const REFERENCE_DATASET_CODES = [
  "HOURLY_RATES",
  "PRODUCTION_CALENDARS",
  "MATERIAL_COSTS",
  "UNIT_CONVERSIONS",
  "SUPPLIER_LEAD_TIMES",
  "STOCK_VALUATION",
  "MARGIN_RATE_CARDS",
  "STOCK_DECISION_POLICIES",
] as const;

export type ReferenceDatasetCode = (typeof REFERENCE_DATASET_CODES)[number];
export type WritableReferenceDatasetCode = Exclude<
  ReferenceDatasetCode,
  "MARGIN_RATE_CARDS" | "STOCK_DECISION_POLICIES"
>;
export type ReferenceReliability = "DECLARED" | "VERIFIED";
export type ReferenceChangeStatus = "PENDING_APPROVAL" | "APPROVED" | "REJECTED" | "APPLIED" | "FAILED";

export type HourlyRateChange = {
  dataset_code: "HOURLY_RATES";
  record_key: string;
  value: { amount: number; currency: string };
};

export type ProductionCalendarChange = {
  dataset_code: "PRODUCTION_CALENDARS";
  record_key: string;
  value: {
    code: string;
    label: string;
    timezone: "Europe/Paris";
    working_days: number[];
    day_start: string;
    day_end: string;
    active: boolean;
  };
};

export type MaterialCostChange = {
  dataset_code: "MATERIAL_COSTS";
  record_key: string;
  value: { unit_price: number; currency: string };
};

export type UnitConversionChange = {
  dataset_code: "UNIT_CONVERSIONS";
  record_key: string;
  value: { purchase_unit: string; stock_unit: string; factor: number };
};

export type SupplierLeadTimeChange = {
  dataset_code: "SUPPLIER_LEAD_TIMES";
  record_key: string;
  value: { lead_time_days: number };
};

export type StockValuationChange = {
  dataset_code: "STOCK_VALUATION";
  record_key: "stock.valuation_method";
  value: { method: "WEIGHTED_AVERAGE" | "FIFO" | "SPECIFIC_IDENTIFICATION" };
};

export type ReferenceChange =
  | HourlyRateChange
  | ProductionCalendarChange
  | MaterialCostChange
  | UnitConversionChange
  | SupplierLeadTimeChange
  | StockValuationChange;

export type ReferenceChangeInput = {
  idempotency_key: string;
  effective_from: string;
  effective_to: string | null;
  reason: string;
  source: string;
  reliability: ReferenceReliability;
  changes: ReferenceChange[];
};

export type ReferenceComparisonItem = {
  dataset_code: WritableReferenceDatasetCode;
  record_key: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
  changed_fields: string[];
  affected_modules: string[];
  warnings: string[];
};

export type ReferencePreviewDTO = {
  effective_from: string;
  effective_to: string | null;
  comparison: ReferenceComparisonItem[];
  affected_modules: string[];
  snapshot_sha256: string;
  request_sha256: string;
  requires_approval: true;
  can_apply_now: boolean;
};

export type ReferenceDatasetSummaryDTO = {
  code: ReferenceDatasetCode;
  domain: string;
  label: string;
  owner: string;
  criticality: "CRITICAL" | "HIGH";
  definition: string;
  unit: string;
  canonical_source: string;
  action_path: string;
  affected_modules: string[];
  change_mode: "GOVERNED" | "SPECIALIZED_WORKFLOW";
  record_count: number;
  missing_count: number;
  freshness_at: string | null;
  reliability: "VERIFIED" | "DECLARED" | "PARTIAL" | "UNAVAILABLE";
};

export type ReferenceRecordDTO = {
  dataset_code: ReferenceDatasetCode;
  record_key: string;
  label: string;
  value: Record<string, unknown>;
  effective_from: string | null;
  effective_to: string | null;
  source: string;
  freshness_at: string | null;
  reliability: "VERIFIED" | "DECLARED" | "PARTIAL" | "UNAVAILABLE";
  version: number | null;
  status: "ACTIVE" | "FUTURE" | "EXPIRED" | "MISSING";
};

export type ReferenceChangeSetDTO = {
  id: string;
  status: ReferenceChangeStatus;
  effective_from: string;
  effective_to: string | null;
  reason: string;
  source: string;
  reliability: ReferenceReliability;
  changes: ReferenceChange[];
  comparison: ReferenceComparisonItem[];
  affected_modules: string[];
  expected_snapshot_sha256: string;
  proposed_by: number;
  approved_by: number | null;
  approved_at: string | null;
  rejected_by: number | null;
  rejected_at: string | null;
  rejection_reason: string | null;
  applied_by: number | null;
  applied_at: string | null;
  failure_code: string | null;
  created_at: string;
  updated_at: string;
};

export type ReferenceDataAuditContext = AuditContext;

export type ReferenceDataCapabilities = {
  view: boolean;
  export: boolean;
  propose: boolean;
  import: boolean;
  approve: boolean;
  apply: boolean;
};
