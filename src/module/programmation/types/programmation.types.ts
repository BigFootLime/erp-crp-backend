export type ProgrammationTaskListItem = {
  id: string;
  piece_technique_id: string;
  piece_code: string;
  piece_designation: string;
  client_id: string | null;
  client_company_name: string | null;
  plan_reference: string | null;
  date_commencement: string;
  date_fin: string;
  programmer_user_id: number | null;
  programmer_name: string | null;
  machine_id: string | null;
  machine_code: string | null;
  machine_name: string | null;
  poste_id: string | null;
  poste_code: string | null;
  poste_label: string | null;
  of_operation_id: string | null;
  calendar_id: string | null;
  calendar_code: string | null;
  calendar_label: string | null;
  calendar_timezone: string | null;
  required_machine_family_code: string | null;
  required_skill_codes: string[];
  version: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

export type Paginated<T> = {
  items: T[];
  total: number;
};

export type ProgrammationRescheduleSource = "POINTER" | "KEYBOARD" | "TOUCH" | "API";

export type ProgrammationRescheduleCandidate = {
  start_date: string;
  end_date: string;
  programmer_user_id: number | null;
  machine_id: string | null;
  poste_id: string | null;
  calendar_id: string | null;
};

export type ProgrammationRescheduleSnapshot = ProgrammationRescheduleCandidate & {
  id: string;
  version: number;
  updated_at: string;
  archived_at: string | null;
  piece_code: string;
  piece_designation: string;
  programmer_name: string | null;
  machine_code: string | null;
  machine_name: string | null;
  poste_code: string | null;
  poste_label: string | null;
  calendar_code: string | null;
  calendar_label: string | null;
  calendar_timezone: string | null;
  of_operation_id: string | null;
  required_machine_family_code: string | null;
  required_skill_codes: string[];
};

export type ProgrammationConstraintConflict = {
  id?: string;
  label?: string;
  start_date?: string;
  end_date?: string;
  resource_type?: "PROGRAMMER" | "MACHINE" | "POSTE" | "CALENDAR" | "DEPENDENCY";
  resource_id?: string;
};

export type ProgrammationConstraintViolation = {
  code: string;
  message: string;
  field: keyof ProgrammationRescheduleCandidate | "version" | "of_operation_id" | null;
  blocking: true;
  conflicts?: ProgrammationConstraintConflict[];
  suggested_action: string;
};

export type ProgrammationSuggestedSlot = {
  candidate: ProgrammationRescheduleCandidate;
  reason: string;
  requires_preview: true;
};

export type ProgrammationReschedulePreview = {
  valid: boolean;
  preview_token: string;
  current: ProgrammationRescheduleSnapshot;
  candidate: ProgrammationRescheduleCandidate;
  violations: ProgrammationConstraintViolation[];
  warnings: Array<{ code: string; message: string }>;
  suggested_slots: ProgrammationSuggestedSlot[];
  expires_when_version_changes: true;
};

export type ProgrammationRescheduleCommitResult = {
  operation_id: string;
  idempotent_replay: boolean;
  status: "APPLIED";
  task: ProgrammationRescheduleSnapshot;
  previous: ProgrammationRescheduleSnapshot;
  audit_id: string;
  notification_ids: string[];
};

export type ProgrammationRescheduleCancelResult = {
  operation_id: string;
  idempotent_replay: boolean;
  status: "CANCELLED";
  task: ProgrammationRescheduleSnapshot;
  compensated: ProgrammationRescheduleSnapshot;
  audit_id: string;
  notification_ids: string[];
};
