export type ReminderPolicyStatus = "DRAFT" | "VALIDATED" | "RETIRED";
export type ReminderLawfulBasis = "CONTRACT" | "LEGITIMATE_INTEREST" | "CONSENT";
export type ReminderDeliveryMode = "MANUAL" | "SANDBOX";
export type ReminderChannel = "EMAIL" | "NONE";

export type ReminderSuggestionStatus =
  | "SUGGESTED"
  | "BLOCKED"
  | "APPROVED"
  | "CLAIMED"
  | "SENT"
  | "FAILED_RETRYABLE"
  | "FAILED_FINAL"
  | "CANCELLED";

export type ReminderPolicy = {
  id: string;
  version: number;
  row_version: number;
  name: string;
  status: ReminderPolicyStatus;
  timezone: string;
  channel: "EMAIL";
  delivery_mode: ReminderDeliveryMode;
  lawful_basis: ReminderLawfulBasis;
  consent_required: boolean;
  cadence_days: number[];
  retry_delays_minutes: number[];
  template_subject: string;
  template_body: string;
  attach_invoice_pdf: boolean;
  validated_at: string | null;
  validated_by: number | null;
  created_at: string;
  updated_at: string;
};

export type ReminderReadiness = {
  ready: boolean;
  reason:
    | "READY"
    | "NO_VALIDATED_POLICY"
    | "PROVIDER_NOT_SANDBOX"
    | "SCHEMA_NOT_INSTALLED";
  provider: "sandbox" | "invalid";
  job_enabled: boolean;
  autonomous_delivery: false;
  active_policy: ReminderPolicy | null;
};

export type ReminderSuggestion = {
  id: string;
  facture_id: number;
  facture_number: string;
  client_id: string;
  client_name: string;
  policy_id: string;
  policy_version: number;
  cadence_step_days: number;
  due_date: string;
  days_overdue: number;
  outstanding_amount: string;
  currency: string;
  channel: ReminderChannel;
  recipient_contact_id: string | null;
  recipient_hint: string | null;
  subject_snapshot: string;
  body_snapshot: string;
  attachment_document_id: string | null;
  status: ReminderSuggestionStatus;
  row_version: number;
  attempt_count: number;
  next_attempt_at: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  approved_at: string | null;
  approved_by: number | null;
  sent_at: string | null;
  provider_message_id: string | null;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  created_at: string;
  updated_at: string;
};

export type ReminderHistoryEvent = {
  id: string;
  suggestion_id: string;
  facture_id: number;
  client_id: string;
  event_type: string;
  from_status: ReminderSuggestionStatus | null;
  to_status: ReminderSuggestionStatus;
  actor_user_id: number | null;
  details: Record<string, unknown>;
  created_at: string;
};

export type ReminderListResult = {
  items: ReminderSuggestion[];
  total: number;
  limit: number;
  offset: number;
};

export type ReminderCycleResult = {
  as_of_date: string;
  generated: number;
  blocked: number;
  cancelled: number;
  already_present: number;
  processed: number;
  sent: number;
  retryable_failures: number;
  final_failures: number;
};
