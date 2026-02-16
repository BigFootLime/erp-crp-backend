export type PlanningEventKind = "OF_OPERATION" | "MAINTENANCE" | "CUSTOM";

export type PlanningEventStatus = "PLANNED" | "IN_PROGRESS" | "DONE" | "CANCELLED" | "BLOCKED";

export type PlanningPriority = "LOW" | "NORMAL" | "HIGH" | "CRITICAL";

export type PlanningMachineResource = {
  resource_type: "MACHINE";
  id: string;
  code: string;
  name: string;
  type: string;
  status: string;
  is_available: boolean;
  archived_at: string | null;
};

export type PlanningPosteResource = {
  resource_type: "POSTE";
  id: string;
  code: string;
  label: string;
  machine_id: string | null;
  machine_code: string | null;
  machine_name: string | null;
  is_active: boolean;
  archived_at: string | null;
};

export type PlanningResources = {
  machines: PlanningMachineResource[];
  postes: PlanningPosteResource[];
};

export type PlanningEventListItem = {
  id: string;
  kind: PlanningEventKind;
  status: PlanningEventStatus;
  priority: PlanningPriority;
  of_id: number | null;
  of_operation_id: string | null;
  machine_id: string | null;
  poste_id: string | null;
  title: string;
  description: string | null;
  start_ts: string;
  end_ts: string;
  allow_overlap: boolean;
  created_at: string;
  updated_at: string;
  archived_at: string | null;

  of_numero: string | null;
  client_id: string | null;
  client_company_name: string | null;
  client_color: string | null;
  client_blocked: boolean | null;
  client_block_reason: string | null;
  piece_code: string | null;
  piece_designation: string | null;
  operation_phase: number | null;
  operation_designation: string | null;
  machine_code: string | null;
  machine_name: string | null;
  poste_code: string | null;
  poste_label: string | null;

  // Optional fields used for planning visuals.
  // These may be populated progressively by backend/DB patches.
  of_date_fin_prevue?: string | null;
  deadline_ts?: string | null;
  stop_reason?: string | null;
  blockers?: string[];
};

export type PlanningEventComment = {
  id: string;
  event_id: string;
  body: string;
  created_by: number | null;
  created_by_username: string | null;
  created_at: string;
};

export type PlanningEventDocument = {
  document_id: string;
  document_name: string;
  type: string | null;
};

export type PlanningEventDetail = {
  event: PlanningEventListItem;
  comments: PlanningEventComment[];
  documents: PlanningEventDocument[];
};

export type Paginated<T> = {
  items: T[];
  total: number;
};
