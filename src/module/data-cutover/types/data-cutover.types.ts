export const CUTOVER_DOMAINS = [
  "CUSTOMER", "SUPPLIER", "ARTICLE", "TECHNICAL_PIECE", "SALES_ORDER",
  "INTERNAL_DEMAND", "SUPPLIER_ORDER", "OPENING_STOCK", "WIP",
  "LEGACY_DELIVERY", "LEGACY_RECEIPT", "OPENING_RECEIVABLE", "OPENING_PAYABLE",
  "LEGACY_PROFORMA", "METROLOGY",
] as const;

export type CutoverDomain = (typeof CUTOVER_DOMAINS)[number];
export type Scalar = string | number | boolean | null;
export type CutoverValues = Record<string, Scalar>;
export type CutoverDecision = "PENDING" | "INCLUDE" | "EXCLUDE";
export type CutoverAccess = { userId: number; isSuperadmin: boolean };
export type CutoverRowStatus = "UNDECIDED" | "MISSING" | "READY" | "EXCLUDED";
export type CutoverField = {
  key: string;
  label: string;
  type: "text" | "number" | "date" | "select" | "boolean";
  required: boolean;
  required_when?: Array<{ field: string; value: Scalar }>;
  options?: string[];
  read_only?: boolean;
  group?: string;
  hint?: string;
  precision?: number;
  min?: number;
  max?: number;
  max_length?: number;
  pattern?: string;
  format?: "email" | "unit" | "currency" | "siret" | "uuid";
  lookup_entity?: "CUSTOMER" | "SUPPLIER" | "ARTICLE" | "TECHNICAL_PIECE" | "CONTRACT";
};
export type CutoverIssue = { field: string | null; code: string; message: string };
export type CutoverSource = { id: string; name: string; sha256: string; snapshot_at: string };
export type CutoverSummary = { total: number; included: number; pending: number; excluded: number; missing: number; ready: number };
export type CutoverRow = {
  id: string; batch_id: string; domain: CutoverDomain; legacy_key: string;
  source_id: string; sheet: string; row_number: number;
  source_values: CutoverValues; values: CutoverValues; source_issues: string[]; source_notes?: string[];
  decision: CutoverDecision; review_note: string; version: number;
  status: CutoverRowStatus; issues: CutoverIssue[];
};
export type CutoverBatch = {
  id: string; name: string; source_system: string; status: "DRAFT" | "VALIDATED";
  version: number; sources: CutoverSource[]; cutoff_at: string | null;
  created_at: string; updated_at: string; created_by: number;
  summary: CutoverSummary;
};
export type CutoverPreview = {
  preview_hash: string; batch_version: number; ready: boolean; summary: CutoverSummary;
  blockers: Array<{ code: string; message: string; row_id?: string; field?: string | null }>;
  reconciliation: Array<{ domain: string; selected_rows: number; ready_rows: number }>;
  required_checklist: string[]; posting_available: false;
};
