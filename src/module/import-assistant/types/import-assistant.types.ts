export const IMPORT_ENTITY_TYPES = [
  "CLIENT",
  "FOURNISSEUR",
  "ARTICLE",
  "PIECE_TECHNIQUE",
  "MACHINE",
  "STOCK_INITIAL",
  "BL_HISTORIQUE",
  "EMPLOYE",
] as const;

export type ImportEntityType = (typeof IMPORT_ENTITY_TYPES)[number];

export const IMPORT_BATCH_STATUSES = [
  "UPLOADED",
  "SIMULATED",
  "READY",
  "IMPORTING",
  "COMPLETED",
  "COMPLETED_WITH_ERRORS",
  "FAILED",
] as const;

export type ImportBatchStatus = (typeof IMPORT_BATCH_STATUSES)[number];

export const IMPORT_ROW_STATUSES = [
  "PENDING",
  "VALID",
  "BLOCKED",
  "DUPLICATE",
  "ALREADY_IMPORTED",
  "PROCESSING",
  "IMPORTED",
  "LINKED",
  "FAILED",
] as const;

export type ImportRowStatus = (typeof IMPORT_ROW_STATUSES)[number];
export type ImportRowAction = "CREATE" | "LINK" | "SKIP";
export type ImportDuplicateStrategy = "REVIEW" | "LINK_EXACT";

export type ImportFieldKind = "text" | "boolean" | "number" | "date" | "enum" | "list" | "uuid";

export type ImportTargetField = {
  key: string;
  label: string;
  kind: ImportFieldKind;
  required?: boolean;
  values?: string[];
  sensitive?: boolean;
  hint?: string;
};

export type ImportDecisionGate = {
  id: string;
  label: string;
  responsible: string;
  evidence: string;
};

export type ImportEntityCapability = {
  entity_type: ImportEntityType;
  label: string;
  order: number;
  confirm_enabled: boolean;
  unavailable_reason: string | null;
  fields: ImportTargetField[];
  decisions: ImportDecisionGate[];
};

export type ImportMapping = {
  legacy_key_column: string;
  columns: Record<string, string>;
  constants: Record<string, string | number | boolean | null>;
  approved_decisions: string[];
  duplicate_strategy: ImportDuplicateStrategy;
};

export type ImportIssue = {
  code: string;
  message: string;
  field: string | null;
  source_value?: unknown;
};

export type ParsedTabularSheet = {
  name: string;
  headers: string[];
  rows: Array<Record<string, string | number | boolean | null>>;
};

export type ParsedTabularFile = {
  sheets: ParsedTabularSheet[];
};

export type ImportBatchSummary = {
  total: number;
  valid: number;
  blocked: number;
  duplicates: number;
  already_imported: number;
  imported: number;
  linked: number;
  failed: number;
};

export type ImportAuditContext = {
  user_id: number;
  ip: string | null;
  user_agent: string | null;
  device_type: string | null;
  os: string | null;
  browser: string | null;
  path: string | null;
  page_key: string | null;
  client_session_id: string | null;
};

export type ImportBatchRow = {
  id: string;
  entity_type: ImportEntityType;
  status: ImportBatchStatus;
  source_system: string;
  source_name: string;
  source_sha256: string;
  source_size: number;
  source_mime: string | null;
  sheet_name: string;
  headers: string[];
  mapping: ImportMapping | null;
  preview_hash: string | null;
  summary: ImportBatchSummary;
  last_error: string | null;
  created_by: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

export type ImportStoredRow = {
  id: string;
  batch_id: string;
  row_number: number;
  legacy_key: string | null;
  source_data: Record<string, unknown>;
  normalized_data: Record<string, unknown> | null;
  status: ImportRowStatus;
  action: ImportRowAction;
  issues: ImportIssue[];
  target_id: string | null;
  target_code: string | null;
  attempts: number;
};

export type ImportTargetResult = {
  id: string;
  code: string | null;
};
