\set ON_ERROR_STOP on

-- Preflight strictement read-only. Il refuse toute adoption d'artefact sans
-- provenance exacte dans le registre immuable du runner.
BEGIN TRANSACTION READ ONLY;

DO $preflight$
DECLARE
  expected_sha256 constant text := 'bc0706c2af406d9a8e9f8221beb05492f9f0f7eba879de26cb77c8542863f514';
  registered_sha256 text;
  registered_applied_at timestamptz;
  registry_entry_exists boolean := false;
  target_table_count integer;
  target_index_count integer;
  target_trigger_count integer;
  target_function_exists boolean := to_regprocedure('public.fn_margin_append_only()') IS NOT NULL;
BEGIN
  IF to_regclass('public.users') IS NULL THEN
    RAISE EXCEPTION 'margin engine preflight: required users table is missing';
  END IF;
  IF to_regrole('cerp_app') IS NULL THEN
    RAISE EXCEPTION 'margin engine preflight: required role cerp_app is missing';
  END IF;
  IF to_regprocedure('pg_catalog.gen_random_uuid()') IS NULL THEN
    RAISE EXCEPTION 'margin engine preflight: gen_random_uuid() is unavailable';
  END IF;

  SELECT COUNT(*)::integer
    INTO target_table_count
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p')
    AND c.relname = ANY (ARRAY[
      'margin_rate_versions', 'margin_rates',
      'margin_input_versions', 'margin_recalculations'
    ]);

  SELECT COUNT(*)::integer
    INTO target_index_count
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'i'
    AND c.relname = ANY (ARRAY[
      'margin_rate_versions_pkey',
      'margin_rate_versions_code_version_uk',
      'margin_rate_versions_supersedes_uk',
      'margin_rate_versions_effective_idx',
      'margin_rates_pkey',
      'margin_rates_version_code_scope_uk',
      'margin_rates_resolution_idx',
      'margin_rates_version_code_scope_coalesced_uk',
      'margin_input_versions_pkey',
      'margin_input_versions_supersedes_uk',
      'margin_input_versions_lookup_idx',
      'margin_recalculations_pkey',
      'margin_recalculations_lookup_idx'
    ]);

  SELECT COUNT(*)::integer
    INTO target_trigger_count
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname = ANY (ARRAY[
      'margin_rate_versions', 'margin_rates',
      'margin_input_versions', 'margin_recalculations'
    ])
    AND NOT t.tgisinternal;

  IF to_regclass('public.cerp_schema_migrations') IS NOT NULL THEN
    SELECT sha256, applied_at
      INTO registered_sha256, registered_applied_at
    FROM public.cerp_schema_migrations
    WHERE filename = '20260805_margin_engine_0001.sql';
    registry_entry_exists := FOUND;
  END IF;

  IF registry_entry_exists THEN
    IF registered_sha256 IS DISTINCT FROM expected_sha256 OR registered_applied_at IS NULL THEN
      RAISE EXCEPTION 'margin engine preflight: migration ledger provenance is invalid';
    END IF;
    IF target_table_count <> 4 OR target_index_count <> 13
       OR target_trigger_count <> 4 OR NOT target_function_exists THEN
      RAISE EXCEPTION 'margin engine preflight: ledger exists but target artifacts are incomplete';
    END IF;
    RAISE NOTICE 'margin engine preflight: exact patch is already registered';
    RETURN;
  END IF;

  IF target_table_count <> 0 OR target_index_count <> 0
     OR target_trigger_count <> 0 OR target_function_exists THEN
    RAISE EXCEPTION 'margin engine preflight: target artifact exists without its migration ledger entry';
  END IF;
END
$preflight$;

SELECT current_database() AS database_name,
       current_user AS actor,
       'margin engine preflight passed (read-only)' AS result;

ROLLBACK;
