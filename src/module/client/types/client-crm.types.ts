export const CRM_CUSTOMER_KINDS = ["UNSPECIFIED", "PROFESSIONAL", "INDIVIDUAL"] as const;
export const CRM_STAGES = ["TO_QUALIFY", "CONTACTED", "QUALIFIED", "QUOTE_SENT", "NEGOTIATION", "WON", "LOST", "ON_HOLD"] as const;
export const CRM_CONTACT_POLICIES = ["NOT_REVIEWED", "ALLOWED", "EMAIL_OPTOUT", "DO_NOT_CONTACT"] as const;
export const CRM_CHANNELS = ["PHONE", "EMAIL", "MEETING", "INTERNAL"] as const;
export const CRM_PURPOSES = ["INITIAL_CONTACT", "QUOTE_FOLLOW_UP", "ORDER_FOLLOW_UP", "OTHER"] as const;
export const CRM_OUTCOMES = ["CONTACTED", "NO_ANSWER", "INTERESTED", "NOT_INTERESTED", "QUOTE_REQUESTED", "OTHER"] as const;
export const CRM_RESCHEDULE_REASONS = ["CUSTOMER_REQUEST", "INTERNAL_RESCHEDULE", "NO_RESPONSE", "OTHER"] as const;

export type CrmProfile = {
  client_id: string;
  customer_kind: (typeof CRM_CUSTOMER_KINDS)[number];
  stage: (typeof CRM_STAGES)[number];
  owner_user_id: number | null;
  contact_policy: (typeof CRM_CONTACT_POLICIES)[number];
  retention_review_date: string | null;
  version: number;
  updated_at: string | null;
};
export type CrmOwner = { id: number; label: string };
export type CrmFollowup = {
  id: string;
  client_id: string;
  client_code: string | null;
  company_name: string;
  contact_id: string | null;
  contact_label: string | null;
  owner_user_id: number;
  owner_label: string;
  contact_policy: (typeof CRM_CONTACT_POLICIES)[number];
  client_active: boolean;
  channel: (typeof CRM_CHANNELS)[number];
  purpose: (typeof CRM_PURPOSES)[number];
  title: string | null;
  due_at: string;
  status: "PLANNED" | "COMPLETED" | "CANCELLED";
  outcome: (typeof CRM_OUTCOMES)[number] | null;
  result_note: string | null;
  completed_at: string | null;
  version: number;
  created_at: string;
};
export type CrmEvent = {
  id: string;
  client_id: string;
  followup_id: string | null;
  action: "QUALIFY" | "PLAN" | "RESCHEDULE" | "COMPLETE" | "CANCEL" | "LOG_INTERACTION";
  actor_user_id: number;
  actor_label: string;
  occurred_at: string;
  details: Record<string, unknown>;
};
export type CrmPage<T> = { items: T[]; total: number; page: number; page_size: number };
export type CrmCommandResult = { event_id: string; profile?: CrmProfile; followup?: CrmFollowup };
export function emptyCrmProfile(clientId: string): CrmProfile {
  return { client_id: clientId, customer_kind: "UNSPECIFIED", stage: "TO_QUALIFY", owner_user_id: null,
    contact_policy: "NOT_REVIEWED", retention_review_date: null, version: 0, updated_at: null };
}
