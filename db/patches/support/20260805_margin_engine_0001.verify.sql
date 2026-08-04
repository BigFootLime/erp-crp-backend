\set ON_ERROR_STOP on

-- Verification bloquante et read-only de la provenance et de la forme exacte.
BEGIN TRANSACTION READ ONLY;

DO $verify$
DECLARE
  expected_sha256 constant text := 'bc0706c2af406d9a8e9f8221beb05492f9f0f7eba879de26cb77c8542863f514';
  registered_sha256 text;
  registered_applied_at timestamptz;
  cerp_app_oid oid;
  owned_table_count integer;
  function_owner oid;
  function_security_definer boolean;
  function_config text[];
  total_constraint_count integer;
  expected_constraint_count integer;
  total_index_count integer;
  expected_index_count integer;
  total_trigger_count integer;
  expected_trigger_count integer;
  public_table_acl_count integer;
  public_function_acl_count integer;
BEGIN
  IF to_regclass('public.cerp_schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'margin engine verify: migration registry is missing';
  END IF;

  SELECT sha256, applied_at
    INTO registered_sha256, registered_applied_at
  FROM public.cerp_schema_migrations
  WHERE filename = '20260805_margin_engine_0001.sql';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'margin engine verify: migration registry entry is missing';
  END IF;
  IF registered_sha256 IS DISTINCT FROM expected_sha256 OR registered_applied_at IS NULL THEN
    RAISE EXCEPTION 'margin engine verify: migration ledger provenance is invalid';
  END IF;

  IF to_regrole('cerp_app') IS NULL THEN
    RAISE EXCEPTION 'margin engine verify: required role cerp_app is missing';
  END IF;
  cerp_app_oid := to_regrole('cerp_app');

  IF to_regclass('public.margin_rate_versions') IS NULL
     OR to_regclass('public.margin_rates') IS NULL
     OR to_regclass('public.margin_input_versions') IS NULL
     OR to_regclass('public.margin_recalculations') IS NULL
     OR to_regprocedure('public.fn_margin_append_only()') IS NULL THEN
    RAISE EXCEPTION 'margin engine verify: required table or append-only function is missing';
  END IF;

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

  IF owned_table_count <> 4 THEN
    RAISE EXCEPTION 'margin engine verify: all target tables must be owned by cerp_app';
  END IF;

  SELECT p.proowner, p.prosecdef, p.proconfig
    INTO function_owner, function_security_definer, function_config
  FROM pg_proc p
  WHERE p.oid = 'public.fn_margin_append_only()'::regprocedure;

  IF function_owner IS DISTINCT FROM cerp_app_oid
     OR function_security_definer IS DISTINCT FROM false
     OR NOT (COALESCE(function_config, ARRAY[]::text[]) @> ARRAY['search_path=pg_catalog, public']) THEN
    RAISE EXCEPTION 'margin engine verify: append-only function owner or execution context is invalid';
  END IF;
  IF position(
       'is append-only; create a superseding version instead'
       IN pg_get_functiondef('public.fn_margin_append_only()'::regprocedure)
     ) = 0 THEN
    RAISE EXCEPTION 'margin engine verify: append-only function body is unexpected';
  END IF;

  IF (SELECT array_agg(column_name::text ORDER BY ordinal_position)
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'margin_rate_versions')
     IS DISTINCT FROM ARRAY[
       'id','code','version','currency','effective_from','effective_to','source',
       'assumption_date','notes','supersedes_id','created_by','created_at'
     ]::text[] THEN
    RAISE EXCEPTION 'margin engine verify: margin_rate_versions columns are altered';
  END IF;

  IF (SELECT array_agg(column_name::text ORDER BY ordinal_position)
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'margin_rates')
     IS DISTINCT FROM ARRAY[
       'id','rate_version_id','rate_code','category','scope_type','scope_ref',
       'amount','unit','source_ref','created_at'
     ]::text[] THEN
    RAISE EXCEPTION 'margin engine verify: margin_rates columns are altered';
  END IF;

  IF (SELECT array_agg(column_name::text ORDER BY ordinal_position)
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'margin_input_versions')
     IS DISTINCT FROM ARRAY[
       'id','scope_type','scope_ref','basis','input_key','input_kind','category',
       'availability','amount_ht','quantity','rate_id','rate_effective_at',
       'rate_validation_snapshot','currency','source_type','source_ref','observed_at',
       'assumption','assumption_date','supersedes_id','created_by','created_at'
     ]::text[] THEN
    RAISE EXCEPTION 'margin engine verify: margin_input_versions columns are altered';
  END IF;

  IF (SELECT array_agg(column_name::text ORDER BY ordinal_position)
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'margin_recalculations')
     IS DISTINCT FROM ARRAY[
       'id','scope_type','scope_ref','basis','as_of','formula_version',
       'calculation_hash','input_snapshot','result_snapshot','created_by','created_at'
     ]::text[] THEN
    RAISE EXCEPTION 'margin engine verify: margin_recalculations columns are altered';
  END IF;

  SELECT COUNT(*)::integer,
         COUNT(*) FILTER (WHERE convalidated AND conname = ANY (ARRAY[
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
         ]))::integer
    INTO total_constraint_count, expected_constraint_count
  FROM pg_constraint
  WHERE conrelid = ANY (ARRAY[
    'public.margin_rate_versions'::regclass,
    'public.margin_rates'::regclass,
    'public.margin_input_versions'::regclass,
    'public.margin_recalculations'::regclass
  ]::oid[]);

  IF total_constraint_count <> 44 OR expected_constraint_count <> 44 THEN
    RAISE EXCEPTION 'margin engine verify: constraints are incomplete, altered or additional';
  END IF;

  SELECT COUNT(*)::integer,
         COUNT(*) FILTER (
           WHERE i.indisvalid AND i.indisready AND c.relowner = cerp_app_oid
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
             ])
         )::integer
    INTO total_index_count, expected_index_count
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indexrelid
  WHERE i.indrelid = ANY (ARRAY[
    'public.margin_rate_versions'::regclass,
    'public.margin_rates'::regclass,
    'public.margin_input_versions'::regclass,
    'public.margin_recalculations'::regclass
  ]::oid[]);

  IF total_index_count <> 13 OR expected_index_count <> 13 THEN
    RAISE EXCEPTION 'margin engine verify: indexes are incomplete, altered or additional';
  END IF;

  SELECT COUNT(*)::integer,
         COUNT(*) FILTER (
           WHERE t.tgname = ANY (ARRAY[
             'trg_margin_rate_versions_append_only',
             'trg_margin_rates_append_only',
             'trg_margin_input_versions_append_only',
             'trg_margin_recalculations_append_only'
           ])
             AND t.tgfoid = 'public.fn_margin_append_only()'::regprocedure
             AND t.tgenabled = 'O'
             AND t.tgtype = 27
         )::integer
    INTO total_trigger_count, expected_trigger_count
  FROM pg_trigger t
  WHERE NOT t.tgisinternal
    AND t.tgrelid = ANY (ARRAY[
      'public.margin_rate_versions'::regclass,
      'public.margin_rates'::regclass,
      'public.margin_input_versions'::regclass,
      'public.margin_recalculations'::regclass
    ]::oid[]);

  IF total_trigger_count <> 4 OR expected_trigger_count <> 4 THEN
    RAISE EXCEPTION 'margin engine verify: append-only triggers are incomplete, altered or additional';
  END IF;

  IF NOT has_table_privilege('cerp_app', 'public.margin_rate_versions', 'SELECT,INSERT')
     OR NOT has_table_privilege('cerp_app', 'public.margin_rates', 'SELECT,INSERT')
     OR NOT has_table_privilege('cerp_app', 'public.margin_input_versions', 'SELECT,INSERT')
     OR NOT has_table_privilege('cerp_app', 'public.margin_recalculations', 'SELECT,INSERT')
     OR NOT has_function_privilege('cerp_app', 'public.fn_margin_append_only()', 'EXECUTE') THEN
    RAISE EXCEPTION 'margin engine verify: runtime read/append privileges are missing';
  END IF;

  SELECT COUNT(*)::integer
    INTO public_table_acl_count
  FROM pg_class c
  CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) acl
  WHERE c.oid = ANY (ARRAY[
      'public.margin_rate_versions'::regclass,
      'public.margin_rates'::regclass,
      'public.margin_input_versions'::regclass,
      'public.margin_recalculations'::regclass
    ]::oid[])
    AND acl.grantee = 0;

  SELECT COUNT(*)::integer
    INTO public_function_acl_count
  FROM pg_proc p
  CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
  WHERE p.oid = 'public.fn_margin_append_only()'::regprocedure
    AND acl.grantee = 0;

  IF public_table_acl_count <> 0 OR public_function_acl_count <> 0 THEN
    RAISE EXCEPTION 'margin engine verify: PUBLIC retains a target privilege';
  END IF;
END
$verify$;

SELECT current_database() AS database_name,
       (SELECT sha256 FROM public.cerp_schema_migrations
        WHERE filename = '20260805_margin_engine_0001.sql') AS migration_sha256,
       4 AS verified_tables,
       44 AS verified_constraints,
       4 AS verified_append_only_triggers,
       'margin engine verification passed (read-only)' AS result;

ROLLBACK;
