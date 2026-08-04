\set ON_ERROR_STOP on

-- Baseline verification is deliberately blocking: it passes only while both
-- global flags are OFF and no per-user override exists. Run before any signed
-- operational activation; later activation is a separate audited decision.
BEGIN TRANSACTION READ ONLY;

DO $verify$
DECLARE
  expected_sha256 constant text := '76828b33484f604efe1236e7d95fb32101aafaa42aba8b4ec4cc4fbe5db9a717';
  registered_sha256 text;
  registered_applied_at timestamptz;
  table_owner oid;
  function_owner oid;
  target_flag_count integer;
  disabled_flag_count integer;
  override_count integer;
  total_column_count integer;
  expected_column_count integer;
  total_constraint_count integer;
  expected_constraint_count integer;
BEGIN
  IF to_regclass('public.cerp_schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'dashboard convergence verify: migration registry is missing';
  END IF;

  SELECT sha256, applied_at
    INTO registered_sha256, registered_applied_at
  FROM public.cerp_schema_migrations
  WHERE filename = '20260805_dashboard_convergence_governance.sql';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'dashboard convergence verify: migration registry entry is missing';
  END IF;
  IF registered_sha256 IS DISTINCT FROM expected_sha256 OR registered_applied_at IS NULL THEN
    RAISE EXCEPTION 'dashboard convergence verify: migration ledger provenance is invalid';
  END IF;

  IF to_regclass('public.dashboard_usage_daily') IS NULL
     OR to_regprocedure('public.prune_dashboard_usage_daily(integer)') IS NULL THEN
    RAISE EXCEPTION 'dashboard convergence verify: table or retention function is missing';
  END IF;

  SELECT relowner
    INTO table_owner
  FROM pg_class
  WHERE oid = 'public.dashboard_usage_daily'::regclass;

  SELECT proowner
    INTO function_owner
  FROM pg_proc
  WHERE oid = 'public.prune_dashboard_usage_daily(integer)'::regprocedure;

  IF table_owner IS DISTINCT FROM to_regrole('cerp_app')
     OR function_owner IS DISTINCT FROM to_regrole('cerp_app') THEN
    RAISE EXCEPTION 'dashboard convergence verify: runtime ownership is not cerp_app';
  END IF;

  SELECT COUNT(*)::integer,
         COUNT(*) FILTER (WHERE enabled IS FALSE AND environment = 'all')::integer
    INTO target_flag_count, disabled_flag_count
  FROM public.app_feature_flags
  WHERE key IN ('DASHBOARD_ARIANE_DEFAULT', 'DASHBOARD_USAGE_METRICS');

  IF target_flag_count <> 2 OR disabled_flag_count <> 2 THEN
    RAISE EXCEPTION 'dashboard convergence verify: both baseline flags must exist globally and remain OFF';
  END IF;

  SELECT COUNT(*)::integer
    INTO override_count
  FROM public.app_feature_flag_users ffu
  JOIN public.app_feature_flags ff ON ff.id = ffu.feature_flag_id
  WHERE ff.key IN ('DASHBOARD_ARIANE_DEFAULT', 'DASHBOARD_USAGE_METRICS');

  IF override_count <> 0 THEN
    RAISE EXCEPTION 'dashboard convergence verify: user overrides are forbidden before signed activation';
  END IF;

  SELECT COUNT(*)::integer,
         COUNT(*) FILTER (WHERE column_name = ANY (ARRAY[
           'usage_date', 'experience', 'event_type', 'selection_source',
           'previous_experience', 'role_bucket', 'event_count',
           'first_seen_at', 'last_seen_at'
         ]))::integer
    INTO total_column_count, expected_column_count
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'dashboard_usage_daily';

  IF total_column_count <> 9 OR expected_column_count <> 9 THEN
    RAISE EXCEPTION 'dashboard convergence verify: table columns are incomplete or additional';
  END IF;

  SELECT COUNT(*)::integer,
         COUNT(*) FILTER (WHERE conname = ANY (ARRAY[
           'dashboard_usage_daily_pkey',
           'dashboard_usage_daily_experience_ck',
           'dashboard_usage_daily_event_ck',
           'dashboard_usage_daily_source_ck',
           'dashboard_usage_daily_previous_ck',
           'dashboard_usage_daily_role_ck',
           'dashboard_usage_daily_count_ck'
         ]) AND convalidated)::integer
    INTO total_constraint_count, expected_constraint_count
  FROM pg_constraint
  WHERE conrelid = 'public.dashboard_usage_daily'::regclass;

  IF total_constraint_count <> 7 OR expected_constraint_count <> 7 THEN
    RAISE EXCEPTION 'dashboard convergence verify: table constraints are incomplete, altered or additional';
  END IF;

  IF NOT has_table_privilege('cerp_app', 'public.dashboard_usage_daily', 'SELECT,INSERT,UPDATE,DELETE')
     OR NOT has_function_privilege('cerp_app', 'public.prune_dashboard_usage_daily(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'dashboard convergence verify: runtime DML or maintenance privilege is missing';
  END IF;
END
$verify$;

SELECT
  current_database() AS database_name,
  (SELECT sha256 FROM public.cerp_schema_migrations
   WHERE filename = '20260805_dashboard_convergence_governance.sql') AS migration_sha256,
  (SELECT enabled FROM public.app_feature_flags
   WHERE key = 'DASHBOARD_ARIANE_DEFAULT') AS ariane_enabled,
  (SELECT enabled FROM public.app_feature_flags
   WHERE key = 'DASHBOARD_USAGE_METRICS') AS telemetry_enabled,
  'dashboard convergence baseline verification passed (read-only)' AS result;

ROLLBACK;
