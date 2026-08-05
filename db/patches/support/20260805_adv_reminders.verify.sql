\set ON_ERROR_STOP on

BEGIN TRANSACTION READ ONLY;

DO $verify$
DECLARE
  expected_sha256 constant text := '060e1e8a3dcaaa673bb24beebb4701af0e82ca165ceaf3fe9466138f19cfcc2d';
  registered_sha256 text;
  owner_count integer;
  trigger_count integer;
BEGIN
  SELECT sha256 INTO registered_sha256
  FROM public.cerp_schema_migrations
  WHERE filename='20260805_adv_reminders.sql';
  IF registered_sha256 IS DISTINCT FROM expected_sha256 THEN
    RAISE EXCEPTION 'FEAT-CERP-0002 verify: exact migration checksum is not registered';
  END IF;
  IF to_regclass('public.adv_reminder_policies') IS NULL
     OR to_regclass('public.adv_reminder_client_preferences') IS NULL
     OR to_regclass('public.adv_reminder_suggestions') IS NULL
     OR to_regclass('public.adv_reminder_events') IS NULL
     OR to_regclass('public.adv_reminder_attempts') IS NULL
     OR to_regclass('public.adv_reminder_command_receipts') IS NULL THEN
    RAISE EXCEPTION 'FEAT-CERP-0002 verify: one or more target tables are missing';
  END IF;
  IF (SELECT COUNT(*) FROM public.app_modules WHERE module_key='facturation'
      AND '/adv-reminders'=ANY(api_prefixes) AND 'relances'=ANY(nav_page_keys))<>1 THEN
    RAISE EXCEPTION 'FEAT-CERP-0002 verify: module catalogue mapping is missing or duplicated';
  END IF;
  SELECT COUNT(*)::integer INTO owner_count
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relname=ANY(ARRAY[
    'adv_reminder_policies','adv_reminder_client_preferences','adv_reminder_suggestions',
    'adv_reminder_events','adv_reminder_attempts','adv_reminder_command_receipts'
  ]) AND c.relowner=to_regrole('cerp_app');
  IF owner_count<>6 THEN
    RAISE EXCEPTION 'FEAT-CERP-0002 verify: runtime table ownership is not exact';
  END IF;
  SELECT COUNT(*)::integer INTO trigger_count
  FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='O' AND tgname=ANY(ARRAY[
    'adv_reminder_events_append_only','adv_reminder_attempts_append_only','adv_reminder_receipts_append_only',
    'adv_reminder_cancel_on_facture_change','adv_reminder_cancel_on_payment_allocation',
    'adv_reminder_cancel_on_direct_payment','adv_reminder_cancel_on_credit_allocation',
    'adv_reminder_cancel_on_direct_credit'
  ]);
  IF trigger_count<>8 THEN
    RAISE EXCEPTION 'FEAT-CERP-0002 verify: immutable/cancellation triggers are missing or disabled';
  END IF;
  IF EXISTS (
    SELECT facture_id,cadence_step_days FROM public.adv_reminder_suggestions
    GROUP BY facture_id,cadence_step_days HAVING COUNT(*)>1
  ) THEN
    RAISE EXCEPTION 'FEAT-CERP-0002 verify: invoice/cadence idempotence is violated';
  END IF;
  IF (SELECT COUNT(*) FROM public.adv_reminder_policies WHERE status='VALIDATED')>1 THEN
    RAISE EXCEPTION 'FEAT-CERP-0002 verify: policy fail-closed invariant is violated';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.adv_reminder_attempts
    WHERE provider<>'sandbox' OR recipient_hash !~ '^[0-9a-f]{64}$' AND status='SENT'
  ) THEN
    RAISE EXCEPTION 'FEAT-CERP-0002 verify: provider or minimized recipient evidence is invalid';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.adv_reminder_suggestions
    WHERE status='SENT' AND (sent_at IS NULL OR provider_message_id IS NULL)
  ) THEN
    RAISE EXCEPTION 'FEAT-CERP-0002 verify: sent state lacks its evidence';
  END IF;
END
$verify$;

ROLLBACK;
