\set ON_ERROR_STOP on

DO $$ BEGIN
  IF current_database()<>'cerp_test' AND current_setting('cerp.migration_rehearsal',true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'Rollback SOL-23 autorise uniquement sur cerp_test ou une repetition isolee; restaurer la sauvegarde en production';
  END IF;
  IF to_regclass('public.adv_case_events') IS NOT NULL AND EXISTS(SELECT 1 FROM public.adv_case_events) THEN RAISE EXCEPTION 'Rollback refuse: historique ADV present'; END IF;
  IF to_regclass('public.adv_otif_assessments') IS NOT NULL AND EXISTS(SELECT 1 FROM public.adv_otif_assessments) THEN RAISE EXCEPTION 'Rollback refuse: preuves OTIF presentes'; END IF;
END $$;

BEGIN;
DROP TRIGGER IF EXISTS trg_adv_freeze_otif_0455 ON public.bon_livraison;
DROP FUNCTION IF EXISTS public.adv_freeze_otif_0455();
DROP TABLE IF EXISTS public.adv_command_receipts;
DROP TRIGGER IF EXISTS trg_adv_otif_append_only_0455 ON public.adv_otif_assessments;
DROP TABLE IF EXISTS public.adv_otif_assessments;
DROP TRIGGER IF EXISTS trg_adv_case_events_append_only_0455 ON public.adv_case_events;
DROP TABLE IF EXISTS public.adv_case_events;
DROP TRIGGER IF EXISTS trg_adv_invoice_disputes_transition_0455 ON public.adv_invoice_disputes;
DROP TABLE IF EXISTS public.adv_invoice_disputes;
DROP TRIGGER IF EXISTS trg_adv_payment_promises_transition_0455 ON public.adv_payment_promises;
DROP TABLE IF EXISTS public.adv_payment_promises;
DROP TRIGGER IF EXISTS trg_adv_delivery_blocks_transition_0455 ON public.adv_delivery_blocks;
DROP TABLE IF EXISTS public.adv_delivery_blocks;
DROP FUNCTION IF EXISTS public.adv_case_transition_guard_0455();
DROP FUNCTION IF EXISTS public.adv_append_only_guard_0455();
COMMIT;
