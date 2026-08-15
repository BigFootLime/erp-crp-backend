-- Rollback is allowed only while no label or audit evidence exists.
BEGIN;

DO $rollback_guard$
DECLARE
  evidence bigint := 0;
BEGIN
  IF to_regclass('public.identification_labels') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.identification_labels' INTO evidence;
  END IF;
  IF evidence = 0 AND to_regclass('public.identification_scan_events') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.identification_scan_events' INTO evidence;
  END IF;
  IF evidence = 0 AND to_regclass('public.identification_audit_events') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.identification_audit_events' INTO evidence;
  END IF;
  IF evidence > 0 THEN
    RAISE EXCEPTION 'SOL-30 rollback refused: label or audit evidence exists';
  END IF;
END
$rollback_guard$;

DROP TRIGGER IF EXISTS trg_identification_print_events_immutable_sol30 ON public.identification_print_events;
DROP TRIGGER IF EXISTS trg_identification_scan_events_immutable_sol30 ON public.identification_scan_events;
DROP TRIGGER IF EXISTS trg_identification_receipts_immutable_sol30 ON public.identification_command_receipts;
DROP TRIGGER IF EXISTS trg_identification_audit_immutable_sol30 ON public.identification_audit_events;
DROP TABLE IF EXISTS public.identification_audit_events;
DROP TABLE IF EXISTS public.identification_command_receipts;
DROP TABLE IF EXISTS public.identification_scan_events;
DROP TABLE IF EXISTS public.identification_print_events;
DROP TABLE IF EXISTS public.identification_labels;
DROP FUNCTION IF EXISTS public.fn_identification_evidence_immutable_sol30();

COMMIT;

DO $verify_rollback$
BEGIN
  IF to_regclass('public.identification_labels') IS NOT NULL
     OR to_regclass('public.identification_scan_events') IS NOT NULL
     OR to_regclass('public.identification_audit_events') IS NOT NULL THEN
    RAISE EXCEPTION 'SOL-30 rollback verification failed';
  END IF;
END
$verify_rollback$;
