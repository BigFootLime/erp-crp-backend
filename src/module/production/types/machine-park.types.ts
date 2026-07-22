export type MachineUnavailabilityCause =
  | "PREVENTIVE_MAINTENANCE"
  | "BREAKDOWN"
  | "QUALIFICATION"
  | "RESERVATION"
  | "WORKSHOP_CLOSURE"
  | "OPERATOR_ABSENCE"
  | "OTHER";

export type MachineUnavailability = {
  id: string;
  machine_id: string;
  planning_event_id: string;
  cause: MachineUnavailabilityCause;
  comment: string | null;
  source: string;
  maintenance_plan_id: string | null;
  start_ts: string;
  end_ts: string;
  status: string;
  created_at: string;
  created_by: number | null;
  archived_at: string | null;
};

export type MachineMaintenancePlan = {
  id: string;
  machine_id: string;
  title: string;
  status: "ACTIVE" | "PAUSED" | "COMPLETED";
  frequency_days: number | null;
  frequency_counter: number | null;
  counter_unit: string | null;
  next_due_at: string | null;
  responsible_user_id: number | null;
  checklist: unknown[];
  document_id: string | null;
  source: string;
  notes: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

export type MachineMaintenanceEvent = {
  id: string;
  machine_id: string;
  maintenance_plan_id: string | null;
  event_type: "SCHEDULED" | "STARTED" | "COMPLETED" | "CANCELLED" | "NOTE";
  occurred_at: string;
  due_at: string | null;
  planning_event_id: string | null;
  unavailability_id: string | null;
  checklist_result: unknown[];
  notes: string | null;
  created_at: string;
  created_by: number | null;
};

export type MachineParkContext = {
  available_now: boolean;
  availability_reason: string;
  active_unavailability: MachineUnavailability | null;
  upcoming_unavailability: MachineUnavailability[];
  maintenance_due: MachineMaintenancePlan[];
  planned_minutes_next_7d: number;
  capacity_minutes_next_7d: null;
  capacity_reason: string;
  linked_open_ofs: Array<{ id: number; numero: string; statut: string; operation_count: number }>;
};
