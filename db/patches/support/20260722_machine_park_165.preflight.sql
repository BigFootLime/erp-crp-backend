\set ON_ERROR_STOP on

SELECT
  to_regclass('public.machines') IS NOT NULL AS has_machines,
  to_regclass('public.production_machine_models') IS NOT NULL AS has_machine_models,
  to_regclass('public.planning_events') IS NOT NULL AS has_planning_events,
  to_regprocedure('public.fn_next_issued_code_value(text)') IS NOT NULL AS has_code_allocator;

SELECT
  count(*) AS machines,
  count(*) FILTER (WHERE hourly_rate = 0) AS zero_rates_to_review,
  count(*) FILTER (WHERE archived_at IS NOT NULL) AS archived_machines
FROM public.machines;

SELECT prosrc ~ 'MCH' AS whitelist_already_has_mch
FROM pg_proc
WHERE proname = 'fn_next_issued_code_value' AND pronamespace = 'public'::regnamespace;

SELECT EXISTS (
  SELECT 1 FROM public.cerp_schema_migrations
  WHERE filename = '20260722_machine_park_165.sql'
) AS migration_already_recorded;
