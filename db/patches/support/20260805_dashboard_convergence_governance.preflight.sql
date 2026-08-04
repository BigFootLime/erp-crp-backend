\set ON_ERROR_STOP on

-- Read-only preflight. It refuses to let the runner bless pre-existing target
-- artifacts or flags that have no matching immutable ledger entry.
BEGIN TRANSACTION READ ONLY;

DO $preflight$
DECLARE
  expected_sha256 constant text := '76828b33484f604efe1236e7d95fb32101aafaa42aba8b4ec4cc4fbe5db9a717';
  registered_sha256 text;
  registered_applied_at timestamptz;
  registry_entry_exists boolean := false;
  target_table_exists boolean := to_regclass('public.dashboard_usage_daily') IS NOT NULL;
  target_function_exists boolean := to_regprocedure('public.prune_dashboard_usage_daily(integer)') IS NOT NULL;
  target_flag_count integer;
BEGIN
  IF to_regclass('public.app_feature_flags') IS NULL
     OR to_regclass('public.app_feature_flag_users') IS NULL THEN
    RAISE EXCEPTION 'dashboard convergence preflight: feature-flag foundation is missing';
  END IF;

  IF to_regrole('cerp_app') IS NULL THEN
    RAISE EXCEPTION 'dashboard convergence preflight: required role cerp_app is missing';
  END IF;

  SELECT COUNT(*)::integer
    INTO target_flag_count
  FROM public.app_feature_flags
  WHERE key IN ('DASHBOARD_ARIANE_DEFAULT', 'DASHBOARD_USAGE_METRICS');

  IF to_regclass('public.cerp_schema_migrations') IS NOT NULL THEN
    SELECT sha256, applied_at
      INTO registered_sha256, registered_applied_at
    FROM public.cerp_schema_migrations
    WHERE filename = '20260805_dashboard_convergence_governance.sql';
    registry_entry_exists := FOUND;
  END IF;

  IF registry_entry_exists THEN
    IF registered_sha256 IS DISTINCT FROM expected_sha256 OR registered_applied_at IS NULL THEN
      RAISE EXCEPTION 'dashboard convergence preflight: migration ledger provenance is invalid';
    END IF;
    IF NOT target_table_exists OR NOT target_function_exists OR target_flag_count <> 2 THEN
      RAISE EXCEPTION 'dashboard convergence preflight: ledger exists but target artifacts are incomplete';
    END IF;
    RAISE NOTICE 'dashboard convergence preflight: exact patch is already registered';
    RETURN;
  END IF;

  IF target_table_exists OR target_function_exists OR target_flag_count <> 0 THEN
    RAISE EXCEPTION 'dashboard convergence preflight: target artifact or flag exists without its migration ledger entry';
  END IF;
END
$preflight$;

SELECT current_database() AS database_name,
       current_user AS actor,
       'dashboard convergence preflight passed (read-only)' AS result;

ROLLBACK;
