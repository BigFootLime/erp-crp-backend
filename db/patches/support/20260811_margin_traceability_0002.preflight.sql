\set ON_ERROR_STOP on
BEGIN TRANSACTION READ ONLY;

DO $preflight$
BEGIN
  IF current_database() NOT IN ('cerp_dev', 'cerp_test', 'cerp_prod') THEN
    RAISE EXCEPTION 'SOL-13 preflight: database % is not approved', current_database();
  END IF;
  IF to_regclass('public.margin_input_versions') IS NULL
     OR to_regclass('public.margin_rates') IS NULL
     OR to_regclass('public.margin_recalculations') IS NULL THEN
    RAISE EXCEPTION 'SOL-13 preflight: base margin engine is missing';
  END IF;
  IF to_regclass('public.cerp_schema_migrations') IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.cerp_schema_migrations
    WHERE filename = '20260805_margin_engine_0001.sql'
      AND sha256 = 'bc0706c2af406d9a8e9f8221beb05492f9f0f7eba879de26cb77c8542863f514'
  ) THEN
    RAISE EXCEPTION 'SOL-13 preflight: canonical base margin migration is not proven by the ledger';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.cerp_schema_migrations
    WHERE filename = '20260811_margin_traceability_0002.sql'
      AND sha256 <> '8639afd24dfbf6ecd49131d2247c506ec1ca7acc17346bfdbacb61aaf6582d61'
  ) THEN
    RAISE EXCEPTION 'SOL-13 preflight: target migration ledger checksum differs from the canonical patch';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    RAISE EXCEPTION 'SOL-13 preflight: role cerp_app is missing';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND state <> 'idle') THEN
    RAISE EXCEPTION 'SOL-13 preflight: active sessions would make the constraint lock unsafe';
  END IF;
END
$preflight$;

SELECT current_database() AS database_name,
       current_setting('server_version_num')::integer AS server_version_num,
       pg_size_pretty(pg_database_size(current_database())) AS database_size,
       (SELECT count(*) FROM public.margin_input_versions) AS input_version_count,
       (SELECT count(*) FROM public.margin_recalculations) AS snapshot_count,
       (SELECT sha256 FROM public.cerp_schema_migrations
        WHERE filename = '20260805_margin_engine_0001.sql') AS base_margin_sha256;

ROLLBACK;
