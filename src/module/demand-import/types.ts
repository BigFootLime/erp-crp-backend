export const DEMAND_KINDS = ["FIRM", "FORECAST"] as const;

export type DemandKind = (typeof DEMAND_KINDS)[number];
export type DemandImportDiagnosticLevel = "ERROR" | "WARNING" | "INFO";

/** The exact external identity of one dated demand. It is never derived from article or order data. */
export type DemandImportCompositeKey = {
  external_site: string;
  external_order_key: string;
  external_line_key: string;
  external_schedule_key: string;
};

/** A validated record which can safely be handed to the persistent demand-pilot module. */
export type CanonicalDemandImportRow = DemandImportCompositeKey & {
  source_version: string;
  source_as_of: string;
  kind: DemandKind;
  quantity: number;
  /** Source unit, resolved against the CERP article before persistence. */
  unit: string;
  /** Clayens RAL programmes are a remaining quantity; ordinary exports are totals. */
  quantity_basis?: "TOTAL" | "REMAINING";
  need_date: string;
  customer_order_date?: string;
  source_requested_date?: string;
  source_confirmed_date?: string;
  article_code?: string;
  customer_reference?: string;
  contract_reference?: string;
  comment?: string;
};

export type DemandImportDiagnostic = {
  level: DemandImportDiagnosticLevel;
  code: string;
  message: string;
  field: string | null;
  row_number?: number;
  count?: number;
};

/** Candidate data is retained for the preview even when its mandatory values are absent. */
export type DemandImportPreviewRow = {
  row_number: number;
  candidate: Partial<CanonicalDemandImportRow>;
  diagnostics: DemandImportDiagnostic[];
};

export type DemandImportSummary = {
  total: number;
  valid: number;
  invalid: number;
  duplicate_composite_keys: number;
};

export type DemandImportResult = {
  rows: CanonicalDemandImportRow[];
  preview_rows: DemandImportPreviewRow[];
  diagnostics: DemandImportDiagnostic[];
  summary: DemandImportSummary;
};

export type DemandImportSource =
  | "VISION_SYSTEMS"
  | "VISION_PROGRAMME"
  | "GENERIC";
export type DemandImportRawRow = Record<string, unknown>;

export type DemandImportInput = {
  source: DemandImportSource;
  rows: readonly DemandImportRawRow[];
  /** Trusted file-level metadata supplied by the authenticated import workflow. */
  defaults?: Partial<
    Pick<
      CanonicalDemandImportRow,
      "external_site" | "source_version" | "source_as_of"
    >
  >;
  /** Source row numbers are 1-based file row numbers, including the header row. */
  first_data_row_number?: number;
};

export type DemandImportFileInput = {
  source: DemandImportSource;
  file: Express.Multer.File;
  sheet_name?: string;
  defaults?: DemandImportInput["defaults"];
};
