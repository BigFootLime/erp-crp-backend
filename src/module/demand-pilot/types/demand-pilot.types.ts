export type DemandKind = "FIRM" | "FORECAST";
export type DemandStatus =
  | "PENDING"
  | "REVIEW"
  | "ACCEPTED"
  | "REJECTED"
  | "ACCEPTED_PENDING_MATERIALIZATION"
  | "MATERIALIZED";
export type DemandDiffType = "NEW" | "CHANGED" | "UNCHANGED" | "REMOVED";
export type DemandRow = {
  id: string;
  import_id: string;
  client_id: string;
  external_site: string;
  external_order_key: string;
  external_line_key: string;
  external_schedule_key: string;
  source_version: string;
  source_as_of: string;
  kind: DemandKind;
  quantity: string;
  unit: string;
  quantity_basis: "TOTAL" | "REMAINING";
  need_date: string;
  article_code: string | null;
  article_id: string | null;
  contract_id: string | null;
  contract_line_id: string | null;
  customer_reference: string | null;
  comment: string | null;
  accepted_need_date: string | null;
  counter_offer: {
    id: string;
    due_date: string;
    customer_message: string;
    status: string;
  } | null;
  revision_no: number;
  diff_type: DemandDiffType;
  status: DemandStatus;
  before_snapshot: unknown;
  after_snapshot: unknown;
  created_at: string;
  decided_at: string | null;
  decision_reason: string | null;
  scenario_code: string | null;
  planner_evidence: unknown;
  materialization_ref: string | null;
};
export type PlanningDemandPort = Pick<
  DemandRow,
  | "id"
  | "client_id"
  | "contract_id"
  | "contract_line_id"
  | "article_id"
  | "kind"
  | "quantity"
  | "need_date"
  | "revision_no"
> & { locked: boolean };
