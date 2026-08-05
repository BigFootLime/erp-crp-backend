\set ON_ERROR_STOP on

BEGIN TRANSACTION READ ONLY;

DO $preflight$
DECLARE
  expected_sha256 constant text := '4ac0aa05dc489ae5f882491e7b41cc6e96ac3bcaabd554ecddfb82d6580734dc';
  registered_sha256 text;
  registered_applied_at timestamptz;
  registry_entry_exists boolean := false;
  target_table_exists boolean := to_regclass('public.planning_surface_usage_daily') IS NOT NULL;
  target_function_exists boolean := to_regprocedure('public.prune_planning_surface_usage_daily(integer)') IS NOT NULL;
  target_flag_count integer;
BEGIN
  IF to_regclass('public.app_feature_flags') IS NULL
     OR to_regclass('public.app_feature_flag_users') IS NULL THEN
    RAISE EXCEPTION 'planning convergence preflight: feature-flag foundation is missing';
  END IF;

  IF to_regrole('cerp_app') IS NULL THEN
    RAISE EXCEPTION 'planning convergence preflight: required role cerp_app is missing';
  END IF;

  SELECT COUNT(*)::integer
    INTO target_flag_count
  FROM public.app_feature_flags
  WHERE key IN ('PLANNING_LEGACY_DASHBOARD_RETIREMENT', 'PLANNING_USAGE_METRICS');

  IF to_regclass('public.cerp_schema_migrations') IS NOT NULL THEN
    SELECT sha256, applied_at
      INTO registered_sha256, registered_applied_at
    FROM public.cerp_schema_migrations
    WHERE filename = '20260805_planning_convergence_governance.sql';
    registry_entry_exists := FOUND;
  END IF;

  IF registry_entry_exists THEN
    IF registered_sha256 IS DISTINCT FROM expected_sha256 OR registered_applied_at IS NULL THEN
      RAISE EXCEPTION 'planning convergence preflight: migration ledger provenance is invalid';
    END IF;
    IF NOT target_table_exists OR NOT target_function_exists OR target_flag_count <> 2 THEN
      RAISE EXCEPTION 'planning convergence preflight: ledger exists but target artifacts are incomplete';
    END IF;
    RAISE NOTICE 'planning convergence preflight: exact patch is already registered';
    RETURN;
  END IF;

  IF target_table_exists OR target_function_exists OR target_flag_count <> 0 THEN
    RAISE EXCEPTION 'planning convergence preflight: target artifact or flag exists without its migration ledger entry';
  END IF;
END
$preflight$;

SELECT current_database() AS database_name,
       current_user AS actor,
       'planning convergence preflight passed (read-only)' AS result;

ROLLBACK;
