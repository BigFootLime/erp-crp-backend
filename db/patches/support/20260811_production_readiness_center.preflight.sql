\set ON_ERROR_STOP on

BEGIN TRANSACTION READ ONLY;

DO $preflight$
BEGIN
  IF current_setting('server_version_num')::integer < 140000 THEN
    RAISE EXCEPTION 'Production readiness preflight: PostgreSQL 14 or newer is required';
  END IF;
  IF to_regprocedure('public.fn_business_prerequisite_status(text)') IS NULL
     OR to_regprocedure('public.fn_enforce_business_prerequisites()') IS NULL THEN
    RAISE EXCEPTION 'Production readiness preflight: SOL-06 readiness functions are missing';
  END IF;
  IF to_regclass('public.programmation_calendars') IS NULL
     OR to_regclass('public.programmation_calendar_closures') IS NULL
     OR to_regclass('public.centres_frais') IS NULL
     OR to_regclass('public.production_cost_center_rates') IS NULL
     OR to_regclass('public.erp_audit_logs') IS NULL THEN
    RAISE EXCEPTION 'Production readiness preflight: a required relation is missing';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.programmation_calendars
    GROUP BY upper(btrim(code)) HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Production readiness preflight: duplicate calendar codes detected';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.programmation_calendars
    WHERE day_start > day_end OR cardinality(working_days) = 0
  ) THEN
    RAISE EXCEPTION 'Production readiness preflight: structurally invalid calendar rows detected';
  END IF;
END
$preflight$;

SELECT
  current_database() AS database_name,
  pg_database_size(current_database()) AS database_bytes,
  (SELECT count(*) FROM public.programmation_calendars) AS calendars,
  (SELECT count(*) FROM public.programmation_calendars WHERE active AND day_start < day_end) AS complete_active_calendars,
  (SELECT count(*) FROM public.centres_frais WHERE statut='ACTIF' AND archived_at IS NULL) AS active_cost_centers,
  (SELECT count(*) FROM public.production_cost_center_rates WHERE taux_horaire > 0) AS positive_rates,
  (SELECT count(*) FROM public.programmation_calendar_closures) AS closures;

COMMIT;
