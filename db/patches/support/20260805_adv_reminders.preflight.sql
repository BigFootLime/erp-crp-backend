\set ON_ERROR_STOP on

BEGIN TRANSACTION READ ONLY;

DO $preflight$
DECLARE
  expected_sha256 constant text := 'df06021c03898c4e719634ab753c986122ad4645ffb7c146c6be0e4954c40616';
  registered_sha256 text;
  target_tables integer;
  target_functions integer;
  target_triggers integer;
  prefix_count integer;
  nav_count integer;
BEGIN
  IF to_regclass('public.cerp_schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'FEAT-CERP-0002 preflight: migration registry is missing';
  END IF;
  IF to_regclass('public.facture') IS NULL
     OR to_regclass('public.facture_echeance') IS NULL
     OR to_regclass('public.facture_documents') IS NULL
     OR to_regclass('public.paiement') IS NULL
     OR to_regclass('public.paiement_allocations') IS NULL
     OR to_regclass('public.avoir') IS NULL
     OR to_regclass('public.avoir_source_allocations') IS NULL
     OR to_regclass('public.clients') IS NULL
     OR to_regclass('public.contacts') IS NULL
     OR to_regclass('public.documents_clients') IS NULL
     OR to_regclass('public.users') IS NULL
     OR to_regclass('public.erp_audit_logs') IS NULL
     OR to_regclass('public.app_modules') IS NULL
     OR to_regrole('cerp_app') IS NULL THEN
    RAISE EXCEPTION 'FEAT-CERP-0002 preflight: prerequisite table or runtime role is missing';
  END IF;
  IF (SELECT COUNT(*) FROM public.app_modules WHERE module_key='facturation') <> 1 THEN
    RAISE EXCEPTION 'FEAT-CERP-0002 preflight: facturation module entry is missing';
  END IF;

  SELECT sha256 INTO registered_sha256
  FROM public.cerp_schema_migrations
  WHERE filename='20260805_adv_reminders.sql';

  SELECT COUNT(*)::integer INTO target_tables
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind='r' AND c.relname=ANY(ARRAY[
    'adv_reminder_policies','adv_reminder_client_preferences','adv_reminder_suggestions',
    'adv_reminder_events','adv_reminder_attempts','adv_reminder_command_receipts'
  ]);
  SELECT COUNT(*)::integer INTO target_functions
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname=ANY(ARRAY[
    'fn_adv_reminder_append_only','fn_adv_reminder_cancel_on_finance_change'
  ]);
  SELECT COUNT(*)::integer INTO target_triggers
  FROM pg_trigger WHERE NOT tgisinternal AND tgname=ANY(ARRAY[
    'adv_reminder_events_append_only','adv_reminder_attempts_append_only','adv_reminder_receipts_append_only',
    'adv_reminder_cancel_on_facture_change','adv_reminder_cancel_on_payment_allocation',
    'adv_reminder_cancel_on_direct_payment','adv_reminder_cancel_on_credit_allocation',
    'adv_reminder_cancel_on_direct_credit'
  ]);
  SELECT COUNT(*)::integer INTO prefix_count
  FROM public.app_modules m,unnest(m.api_prefixes) p
  WHERE m.module_key='facturation' AND p='/adv-reminders';
  SELECT COUNT(*)::integer INTO nav_count
  FROM public.app_modules m,unnest(m.nav_page_keys) p
  WHERE m.module_key='facturation' AND p='relances';

  IF registered_sha256 IS NULL THEN
    IF target_tables<>0 OR target_functions<>0 OR target_triggers<>0 OR prefix_count<>0 OR nav_count<>0 THEN
      RAISE EXCEPTION 'FEAT-CERP-0002 preflight: target artifact exists without ledger provenance';
    END IF;
    RETURN;
  END IF;

  IF registered_sha256<>expected_sha256 THEN
    RAISE EXCEPTION 'FEAT-CERP-0002 preflight: migration ledger checksum is unexpected';
  END IF;
  IF target_tables<>6 OR target_functions<>2 OR target_triggers<>8 OR prefix_count<>1 OR nav_count<>1 THEN
    RAISE EXCEPTION 'FEAT-CERP-0002 preflight: applied migration shape is incomplete';
  END IF;
  IF (SELECT COUNT(*) FROM public.adv_reminder_policies WHERE status='VALIDATED')>1 THEN
    RAISE EXCEPTION 'FEAT-CERP-0002 preflight: more than one policy is validated';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.adv_reminder_attempts
    WHERE provider<>'sandbox' OR (status='SENT' AND recipient_hash IS NULL)
  ) THEN
    RAISE EXCEPTION 'FEAT-CERP-0002 preflight: delivery evidence violates sandbox policy';
  END IF;
END
$preflight$;

ROLLBACK;
