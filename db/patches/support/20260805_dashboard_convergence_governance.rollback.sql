\set ON_ERROR_STOP on

-- Destructive schema rollback is test/dev-only. Production rollback uses the
-- global ARIANE flag and keeps privacy evidence inert until an approved export
-- and retention outcome exist.
BEGIN;
SET TRANSACTION ISOLATION LEVEL READ COMMITTED;

DO $environment_guard$
BEGIN
  IF current_database() NOT IN ('cerp_dev', 'cerp_test') THEN
    RAISE EXCEPTION 'dashboard convergence rollback is restricted to cerp_dev/cerp_test';
  END IF;
END
$environment_guard$;

SELECT pg_advisory_xact_lock(hashtext('cerp_schema_migrations'));

DO $rollback$
DECLARE
  expected_sha256 constant text := '76828b33484f604efe1236e7d95fb32101aafaa42aba8b4ec4cc4fbe5db9a717';
  registered_sha256 text;
  registered_applied_at timestamptz;
  registry_entry_exists boolean := false;
  table_exists boolean := to_regclass('public.dashboard_usage_daily') IS NOT NULL;
  function_exists boolean := to_regprocedure('public.prune_dashboard_usage_daily(integer)') IS NOT NULL;
  target_flag_count integer := 0;
  disabled_flag_count integer := 0;
  override_count integer := 0;
  usage_row_count bigint := 0;
  total_constraint_count integer;
  expected_constraint_count integer;
  table_owner oid;
  function_owner oid;
  deleted_rows integer;
BEGIN
  IF to_regclass('public.app_feature_flags') IS NULL
     OR to_regclass('public.app_feature_flag_users') IS NULL THEN
    RAISE EXCEPTION 'dashboard convergence rollback: feature-flag foundation is missing';
  END IF;

  PERFORM 1
  FROM public.app_feature_flags
  WHERE key IN ('DASHBOARD_ARIANE_DEFAULT', 'DASHBOARD_USAGE_METRICS')
  FOR UPDATE;

  SELECT COUNT(*)::integer,
         COUNT(*) FILTER (WHERE enabled IS FALSE AND environment = 'all')::integer
    INTO target_flag_count, disabled_flag_count
  FROM public.app_feature_flags
  WHERE key IN ('DASHBOARD_ARIANE_DEFAULT', 'DASHBOARD_USAGE_METRICS');

  IF to_regclass('public.cerp_schema_migrations') IS NOT NULL THEN
    SELECT sha256, applied_at
      INTO registered_sha256, registered_applied_at
    FROM public.cerp_schema_migrations
    WHERE filename = '20260805_dashboard_convergence_governance.sql'
    FOR UPDATE;
    registry_entry_exists := FOUND;
  END IF;

  IF NOT table_exists AND NOT function_exists
     AND target_flag_count = 0 AND NOT registry_entry_exists THEN
    RAISE NOTICE 'dashboard convergence rollback: exact artifacts already absent';
    RETURN;
  END IF;

  IF NOT table_exists OR NOT function_exists OR target_flag_count <> 2
     OR NOT registry_entry_exists THEN
    RAISE EXCEPTION 'dashboard convergence rollback: target artifacts or ledger are in a partial state';
  END IF;

  IF registered_sha256 IS DISTINCT FROM expected_sha256 OR registered_applied_at IS NULL THEN
    RAISE EXCEPTION 'dashboard convergence rollback: migration ledger provenance is invalid';
  END IF;

  LOCK TABLE public.dashboard_usage_daily IN ACCESS EXCLUSIVE MODE;

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
    RAISE EXCEPTION 'dashboard convergence rollback: target ownership is unexpected';
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
    RAISE EXCEPTION 'dashboard convergence rollback: table constraints are incomplete, altered or additional';
  END IF;

  IF disabled_flag_count <> 2 THEN
    RAISE EXCEPTION 'dashboard convergence rollback: a target flag is active or altered';
  END IF;

  SELECT COUNT(*)::integer
    INTO override_count
  FROM public.app_feature_flag_users ffu
  JOIN public.app_feature_flags ff ON ff.id = ffu.feature_flag_id
  WHERE ff.key IN ('DASHBOARD_ARIANE_DEFAULT', 'DASHBOARD_USAGE_METRICS');

  IF override_count <> 0 THEN
    RAISE EXCEPTION 'dashboard convergence rollback: user overrides exist';
  END IF;

  SELECT COUNT(*)::bigint INTO usage_row_count FROM public.dashboard_usage_daily;
  IF usage_row_count <> 0 THEN
    RAISE EXCEPTION 'dashboard convergence rollback: usage evidence exists; export/retention decision required';
  END IF;

  EXECUTE 'DROP FUNCTION public.prune_dashboard_usage_daily(integer)';
  EXECUTE 'DROP TABLE public.dashboard_usage_daily';

  DELETE FROM public.app_feature_flags
  WHERE key IN ('DASHBOARD_ARIANE_DEFAULT', 'DASHBOARD_USAGE_METRICS');
  GET DIAGNOSTICS deleted_rows = ROW_COUNT;
  IF deleted_rows <> 2 THEN
    RAISE EXCEPTION 'dashboard convergence rollback: exact feature flags were not removed';
  END IF;

  DELETE FROM public.cerp_schema_migrations
  WHERE filename = '20260805_dashboard_convergence_governance.sql'
    AND sha256 = expected_sha256;
  GET DIAGNOSTICS deleted_rows = ROW_COUNT;
  IF deleted_rows <> 1 THEN
    RAISE EXCEPTION 'dashboard convergence rollback: exact migration ledger row was not removed';
  END IF;

  IF to_regclass('public.dashboard_usage_daily') IS NOT NULL
     OR to_regprocedure('public.prune_dashboard_usage_daily(integer)') IS NOT NULL THEN
    RAISE EXCEPTION 'dashboard convergence rollback: target artifact remains after rollback';
  END IF;
END
$rollback$;

COMMIT;
