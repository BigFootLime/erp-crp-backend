/** Nominative privileges complement module access. Job titles never grant them. */
export const SENSITIVE_CAPABILITIES = [
  "audit.read", "privacy.manage", "hr.sensitive.read", "hr.sensitive.write",
  "finance.validate", "finance.issue", "finance.credit_issue", "finance.payment_allocate",
  "finance.reporting_financial", "finance.reporting_client_detail", "finance.reporting_export",
  "finance.reminder_policy_manage", "finance.reminder_approve", "finance.reminder_send",
  "finance.reminder_retry", "finance.reminder_job_run", "finance.einvoice_submit",
  "finance.einvoice_reconcile", "finance.einvoice_admin", "finance.supplier_invoice_match",
  "finance.supplier_invoice_approve", "finance.supplier_invoice_dispute",
  "finance.ereporting_submit", "finance.accounting_export_execute",
  "finance.accounting_export_admin", "finance.settings_manage",
] as const;

export type SensitiveCapability = (typeof SENSITIVE_CAPABILITIES)[number];
const catalog = new Set<string>(SENSITIVE_CAPABILITIES);
export function isSensitiveCapability(value: unknown): value is SensitiveCapability {
  return typeof value === "string" && catalog.has(value);
}
export function financeSensitiveCapability(value: string): SensitiveCapability | null {
  const key = `finance.${value}`;
  return isSensitiveCapability(key) ? key : null;
}
export type AccountCapabilityState = {
  active: boolean;
  isSuperadmin: boolean;
  capabilities: readonly SensitiveCapability[];
};
export function accountHasSensitiveCapability(state: AccountCapabilityState, capability: SensitiveCapability): boolean {
  return state.active && (state.isSuperadmin || state.capabilities.includes(capability));
}
