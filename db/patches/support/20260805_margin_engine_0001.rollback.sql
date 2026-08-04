\set ON_ERROR_STOP on

-- Rollback destructif strictement reserve aux bases jetables de dev/test.
-- Il refuse les donnees, les artefacts partiels, les owners inattendus et toute
-- provenance differente du checksum canonique du patch.
BEGIN;
SET TRANSACTION ISOLATION LEVEL READ COMMITTED;

DO $environment_guard$
BEGIN
  IF current_database() NOT IN ('cerp_dev', 'cerp_test') THEN
    RAISE EXCEPTION 'margin engine rollback is restricted to cerp_dev/cerp_test';
  END IF;
END
$environment_guard$;

SELECT pg_advisory_xact_lock(hashtext('cerp_schema_migrations'));

DO $rollback$
DECLARE
  expected_sha256 constant text := 'bc0706c2af406d9a8e9f8221beb05492f9f0f7eba879de26cb77c8542863f514';
  expected_constraints constant text[] := ARRAY[
    'margin_rate_versions_pkey',
    'margin_rate_versions_version_ck',
    'margin_rate_versions_currency_ck',
    'margin_rate_versions_source_ck',
    'margin_rate_versions_dates_ck',
    'margin_rate_versions_code_version_uk',
    'margin_rate_versions_no_self_ck',
    'margin_rate_versions_supersedes_fk',
    'margin_rate_versions_created_by_fk',
    'margin_rates_pkey',
    'margin_rates_rate_version_fk',
    'margin_rates_rate_code_ck',
    'margin_rates_category_ck',
    'margin_rates_scope_type_ck',
    'margin_rates_amount_ck',
    'margin_rates_unit_ck',
    'margin_rates_scope_ck',
    'margin_rates_version_code_scope_uk',
    'margin_input_versions_pkey',
    'margin_input_versions_scope_type_ck',
    'margin_input_versions_scope_ref_ck',
    'margin_input_versions_basis_ck',
    'margin_input_versions_input_key_ck',
    'margin_input_versions_input_kind_ck',
    'margin_input_versions_category_ck',
    'margin_input_versions_availability_ck',
    'margin_input_versions_amount_ht_ck',
    'margin_input_versions_quantity_ck',
    'margin_input_versions_rate_fk',
    'margin_input_versions_currency_ck',
    'margin_input_versions_source_type_ck',
    'margin_input_versions_supersedes_fk',
    'margin_input_versions_created_by_fk',
    'margin_input_versions_kind_ck',
    'margin_input_versions_value_ck',
    'margin_input_versions_rate_snapshot_ck',
    'margin_input_versions_assumption_ck',
    'margin_input_versions_no_self_ck',
    'margin_recalculations_pkey',
    'margin_recalculations_scope_type_ck',
    'margin_recalculations_scope_ref_ck',
    'margin_recalculations_basis_ck',
    'margin_recalculations_hash_ck',
    'margin_recalculations_created_by_fk'
  ];
  expected_indexes constant text[] := ARRAY[
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
  ];
  expected_triggers constant text[] := ARRAY[
    'trg_margin_rate_versions_append_only',
    'trg_margin_rates_append_only',
    'trg_margin_input_versions_append_only',
    'trg_margin_recalculations_append_only'
  ];
  registered_sha256 text;
  registered_applied_at timestamptz;
  registry_entry_exists boolean := false;
  cerp_app_oid oid;
  table_count integer;
  index_count integer;
  trigger_count integer;
  function_exists boolean;
  owned_table_count integer;
  function_owner oid;
  total_column_count integer;
  total_constraint_count integer;
  expected_constraint_count integer;
  expected_index_count integer;
  expected_trigger_count integer;
  evidence_row_count bigint;
  deleted_rows integer;
BEGIN
  SELECT COUNT(*)::integer
    INTO table_count
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p')
    AND c.relname = ANY (ARRAY[
      'margin_rate_versions', 'margin_rates',
      'margin_input_versions', 'margin_recalculations'
    ]);

  SELECT COUNT(*)::integer
    INTO index_count
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'i'
    AND c.relname = ANY (expected_indexes);

  SELECT COUNT(*)::integer
    INTO trigger_count
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname = ANY (ARRAY[
      'margin_rate_versions', 'margin_rates',
      'margin_input_versions', 'margin_recalculations'
    ])
    AND NOT t.tgisinternal;

  function_exists := to_regprocedure('public.fn_margin_append_only()') IS NOT NULL;

  IF to_regclass('public.cerp_schema_migrations') IS NOT NULL THEN
    SELECT sha256, applied_at
      INTO registered_sha256, registered_applied_at
    FROM public.cerp_schema_migrations
    WHERE filename = '20260805_margin_engine_0001.sql'
    FOR UPDATE;
    registry_entry_exists := FOUND;
  END IF;

  IF table_count = 0 AND index_count = 0 AND trigger_count = 0
     AND NOT function_exists AND NOT registry_entry_exists THEN
    RAISE NOTICE 'margin engine rollback: exact artifacts already absent';
    RETURN;
  END IF;

  IF table_count <> 4 OR index_count <> 13 OR trigger_count <> 4
     OR NOT function_exists OR NOT registry_entry_exists THEN
    RAISE EXCEPTION 'margin engine rollback: target artifacts or ledger are in a partial/preexisting state';
  END IF;
  IF registered_sha256 IS DISTINCT FROM expected_sha256 OR registered_applied_at IS NULL THEN
    RAISE EXCEPTION 'margin engine rollback: migration ledger provenance is invalid';
  END IF;
  IF to_regrole('cerp_app') IS NULL THEN
    RAISE EXCEPTION 'margin engine rollback: required owner cerp_app is missing';
  END IF;
  cerp_app_oid := to_regrole('cerp_app');

  LOCK TABLE public.margin_recalculations,
             public.margin_input_versions,
             public.margin_rates,
             public.margin_rate_versions
    IN ACCESS EXCLUSIVE MODE;

  SELECT COUNT(*) FILTER (WHERE c.relowner = cerp_app_oid)::integer
    INTO owned_table_count
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p')
    AND c.relname = ANY (ARRAY[
      'margin_rate_versions', 'margin_rates',
      'margin_input_versions', 'margin_recalculations'
    ]);

  SELECT p.proowner
    INTO function_owner
  FROM pg_proc p
  WHERE p.oid = 'public.fn_margin_append_only()'::regprocedure;

  IF owned_table_count <> 4 OR function_owner IS DISTINCT FROM cerp_app_oid THEN
    RAISE EXCEPTION 'margin engine rollback: target ownership is unexpected';
  END IF;

  SELECT COUNT(*)::integer
    INTO total_column_count
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = ANY (ARRAY[
      'margin_rate_versions', 'margin_rates',
      'margin_input_versions', 'margin_recalculations'
    ]);
  IF total_column_count <> 55 THEN
    RAISE EXCEPTION 'margin engine rollback: target columns are incomplete, altered or additional';
  END IF;

  SELECT COUNT(*)::integer,
         COUNT(*) FILTER (WHERE convalidated AND conname = ANY (expected_constraints))::integer
    INTO total_constraint_count, expected_constraint_count
  FROM pg_constraint
  WHERE conrelid = ANY (ARRAY[
    'public.margin_rate_versions'::regclass,
    'public.margin_rates'::regclass,
    'public.margin_input_versions'::regclass,
    'public.margin_recalculations'::regclass
  ]::oid[]);
  IF total_constraint_count <> 44 OR expected_constraint_count <> 44 THEN
    RAISE EXCEPTION 'margin engine rollback: target constraints are incomplete, altered or additional';
  END IF;

  SELECT COUNT(*) FILTER (
           WHERE i.indisvalid AND i.indisready
             AND c.relowner = cerp_app_oid
             AND c.relname = ANY (expected_indexes)
         )::integer
    INTO expected_index_count
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indexrelid
  WHERE i.indrelid = ANY (ARRAY[
    'public.margin_rate_versions'::regclass,
    'public.margin_rates'::regclass,
    'public.margin_input_versions'::regclass,
    'public.margin_recalculations'::regclass
  ]::oid[]);
  IF expected_index_count <> 13 THEN
    RAISE EXCEPTION 'margin engine rollback: target indexes are invalid or unexpectedly owned';
  END IF;

  SELECT COUNT(*) FILTER (
           WHERE t.tgname = ANY (expected_triggers)
             AND t.tgfoid = 'public.fn_margin_append_only()'::regprocedure
             AND t.tgenabled = 'O'
             AND t.tgtype = 27
         )::integer
    INTO expected_trigger_count
  FROM pg_trigger t
  WHERE NOT t.tgisinternal
    AND t.tgrelid = ANY (ARRAY[
      'public.margin_rate_versions'::regclass,
      'public.margin_rates'::regclass,
      'public.margin_input_versions'::regclass,
      'public.margin_recalculations'::regclass
    ]::oid[]);
  IF expected_trigger_count <> 4 THEN
    RAISE EXCEPTION 'margin engine rollback: append-only triggers are invalid';
  END IF;

  SELECT (SELECT COUNT(*) FROM public.margin_rate_versions)
       + (SELECT COUNT(*) FROM public.margin_rates)
       + (SELECT COUNT(*) FROM public.margin_input_versions)
       + (SELECT COUNT(*) FROM public.margin_recalculations)
    INTO evidence_row_count;
  IF evidence_row_count <> 0 THEN
    RAISE EXCEPTION 'margin engine rollback: governed margin evidence exists; export/retention decision required';
  END IF;

  DROP TRIGGER trg_margin_recalculations_append_only ON public.margin_recalculations;
  DROP TRIGGER trg_margin_input_versions_append_only ON public.margin_input_versions;
  DROP TRIGGER trg_margin_rates_append_only ON public.margin_rates;
  DROP TRIGGER trg_margin_rate_versions_append_only ON public.margin_rate_versions;

  DROP TABLE public.margin_recalculations;
  DROP TABLE public.margin_input_versions;
  DROP TABLE public.margin_rates;
  DROP TABLE public.margin_rate_versions;
  DROP FUNCTION public.fn_margin_append_only();

  DELETE FROM public.cerp_schema_migrations
  WHERE filename = '20260805_margin_engine_0001.sql'
    AND sha256 = expected_sha256;
  GET DIAGNOSTICS deleted_rows = ROW_COUNT;
  IF deleted_rows <> 1 THEN
    RAISE EXCEPTION 'margin engine rollback: exact migration ledger row was not removed';
  END IF;

  IF to_regclass('public.margin_rate_versions') IS NOT NULL
     OR to_regclass('public.margin_rates') IS NOT NULL
     OR to_regclass('public.margin_input_versions') IS NOT NULL
     OR to_regclass('public.margin_recalculations') IS NOT NULL
     OR to_regprocedure('public.fn_margin_append_only()') IS NOT NULL THEN
    RAISE EXCEPTION 'margin engine rollback: target artifact remains after rollback';
  END IF;
END
$rollback$;

COMMIT;
