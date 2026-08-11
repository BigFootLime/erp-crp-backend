\set ON_ERROR_STOP on

BEGIN TRANSACTION READ ONLY;

DO $verify$
BEGIN
  IF to_regprocedure('public.fn_business_prerequisite_status_v2(text)') IS NULL THEN
    RAISE EXCEPTION 'Production readiness verify: v2 readiness function is missing';
  END IF;
  IF position(
    'fn_business_prerequisite_status_v2' IN pg_get_functiondef('public.fn_enforce_business_prerequisites()'::regprocedure)
  ) = 0 THEN
    RAISE EXCEPTION 'Production readiness verify: enforcement still targets the legacy function';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid='public.ordres_fabrication'::regclass
      AND tgname='trg_production_reference_readiness_2606' AND tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'Production readiness verify: production trigger is missing or disabled';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.fn_business_prerequisite_status_v2('PRODUCTION')
    WHERE prerequisite_code='ACTIVE_PRODUCTION_CALENDAR'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.fn_business_prerequisite_status_v2('PRODUCTION')
    WHERE prerequisite_code='CURRENT_COST_CENTER_RATES'
  ) THEN
    RAISE EXCEPTION 'Production readiness verify: guided prerequisite rows are missing';
  END IF;
END
$verify$;

SELECT prerequisite_code, ready, unit, source, freshness_at, reliability, actual_value, remediation
FROM public.fn_business_prerequisite_status_v2('PRODUCTION')
ORDER BY prerequisite_code;
COMMIT;
