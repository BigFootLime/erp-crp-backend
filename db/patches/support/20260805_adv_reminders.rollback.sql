\set ON_ERROR_STOP on

-- Dev/test only. Invoke in one psql session with:
--   -c "SET cerp.allow_adv_reminder_rollback='FEAT-CERP-0002'" -f <this-file>
-- The rollback refuses any policy, preference, suggestion, event, attempt or
-- command evidence. Operational evidence is never deleted by this script.

BEGIN;

DO $guard$
DECLARE
  expected_sha256 constant text := 'df06021c03898c4e719634ab753c986122ad4645ffb7c146c6be0e4954c40616';
  registered_sha256 text;
BEGIN
  IF current_database() !~* '(test|dev|local|sandbox)' THEN
    RAISE EXCEPTION 'FEAT-CERP-0002 rollback: only a disposable dev/test database is allowed';
  END IF;
  IF current_setting('cerp.allow_adv_reminder_rollback',true) IS DISTINCT FROM 'FEAT-CERP-0002' THEN
    RAISE EXCEPTION 'FEAT-CERP-0002 rollback: explicit session token is missing';
  END IF;
  SELECT sha256 INTO registered_sha256
  FROM public.cerp_schema_migrations
  WHERE filename='20260805_adv_reminders.sql'
  FOR UPDATE;
  IF registered_sha256 IS DISTINCT FROM expected_sha256 THEN
    RAISE EXCEPTION 'FEAT-CERP-0002 rollback: migration ledger checksum is missing or unexpected';
  END IF;
  IF (SELECT COUNT(*) FROM public.adv_reminder_policies)>0
     OR (SELECT COUNT(*) FROM public.adv_reminder_client_preferences)>0
     OR (SELECT COUNT(*) FROM public.adv_reminder_suggestions)>0
     OR (SELECT COUNT(*) FROM public.adv_reminder_events)>0
     OR (SELECT COUNT(*) FROM public.adv_reminder_attempts)>0
     OR (SELECT COUNT(*) FROM public.adv_reminder_command_receipts)>0 THEN
    RAISE EXCEPTION 'FEAT-CERP-0002 rollback: usage evidence exists; rollback refused';
  END IF;
END
$guard$;

DROP TRIGGER adv_reminder_cancel_on_facture_change ON public.facture;
DROP TRIGGER adv_reminder_cancel_on_payment_allocation ON public.paiement_allocations;
DROP TRIGGER adv_reminder_cancel_on_direct_payment ON public.paiement;
DROP TRIGGER adv_reminder_cancel_on_credit_allocation ON public.avoir_source_allocations;
DROP TRIGGER adv_reminder_cancel_on_direct_credit ON public.avoir;
DROP FUNCTION public.fn_adv_reminder_cancel_on_finance_change();

DROP TABLE public.adv_reminder_command_receipts;
DROP TABLE public.adv_reminder_attempts;
DROP TABLE public.adv_reminder_events;
DROP TABLE public.adv_reminder_suggestions;
DROP TABLE public.adv_reminder_client_preferences;
DROP TABLE public.adv_reminder_policies;
DROP FUNCTION public.fn_adv_reminder_append_only();

UPDATE public.app_modules
SET api_prefixes=array_remove(api_prefixes,'/adv-reminders'),
    nav_page_keys=array_remove(nav_page_keys,'relances'),
    updated_at=now()
WHERE module_key='facturation';

DELETE FROM public.cerp_schema_migrations
WHERE filename='20260805_adv_reminders.sql';

COMMIT;
