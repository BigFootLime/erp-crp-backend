-- Additive, deliberately contains no automatic grants inferred from names or job roles.
BEGIN;
CREATE TABLE IF NOT EXISTS public.app_user_sensitive_capabilities (
  user_id integer NOT NULL REFERENCES public.users(id),
  capability text NOT NULL,
  granted boolean NOT NULL DEFAULT false,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by integer NOT NULL REFERENCES public.users(id),
  PRIMARY KEY (user_id, capability),
  CONSTRAINT sensitive_capability_catalog_1341_ck CHECK (capability IN (
    'audit.read','privacy.manage','hr.sensitive.read','hr.sensitive.write',
    'finance.validate','finance.issue','finance.credit_issue','finance.payment_allocate',
    'finance.reporting_financial','finance.reporting_client_detail','finance.reporting_export',
    'finance.reminder_policy_manage','finance.reminder_approve','finance.reminder_send',
    'finance.reminder_retry','finance.reminder_job_run','finance.einvoice_submit',
    'finance.einvoice_reconcile','finance.einvoice_admin','finance.supplier_invoice_match',
    'finance.supplier_invoice_approve','finance.supplier_invoice_dispute','finance.ereporting_submit',
    'finance.accounting_export_execute','finance.accounting_export_admin','finance.settings_manage'
  ))
);
COMMENT ON TABLE public.app_user_sensitive_capabilities IS
  'Nominative sensitive capabilities supplement module access; no job-title-based grants. Changes are audited in erp_audit_logs.';
DO $runtime_acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    GRANT SELECT, INSERT, UPDATE ON public.app_user_sensitive_capabilities TO cerp_app;
  END IF;
END
$runtime_acl$;
COMMIT;
