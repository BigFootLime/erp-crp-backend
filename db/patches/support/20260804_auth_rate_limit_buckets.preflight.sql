\set ON_ERROR_STOP on

-- Read-only preflight. Run against cerp_test first, then cerp_prod only after
-- the automated backup and release gates have passed.
DO $preflight$
DECLARE
  missing_columns text[];
  registered_sha256 text;
  registry_entry_exists boolean := FALSE;
  target_table_exists boolean;
  target_index_exists boolean;
  expected_sha256 constant text := 'f61120b4068a36138b1d85c0269f764061a525aab6141f99df9c93ad6c5d27a2';
BEGIN
  IF current_database() NOT IN ('cerp_test', 'cerp_prod') THEN
    RAISE EXCEPTION 'SEC-CERP-0005 preflight: unexpected database %', current_database();
  END IF;

  IF to_regrole('cerp_app') IS NULL THEN
    RAISE EXCEPTION 'SEC-CERP-0005 preflight: role cerp_app is missing';
  END IF;

  target_table_exists := to_regclass('public.auth_rate_limit_buckets') IS NOT NULL;
  target_index_exists := to_regclass('public.auth_rate_limit_buckets_expires_at_idx') IS NOT NULL;

  IF to_regclass('public.cerp_schema_migrations') IS NOT NULL THEN
    SELECT sha256
      INTO registered_sha256
    FROM public.cerp_schema_migrations
    WHERE filename = '20260804_auth_rate_limit_buckets.sql';
    registry_entry_exists := FOUND;
  END IF;

  IF (target_table_exists OR target_index_exists) AND NOT registry_entry_exists THEN
    RAISE EXCEPTION
      'SEC-CERP-0005 preflight: target table or index exists without its migration registry entry';
  END IF;

  IF registry_entry_exists AND registered_sha256 IS DISTINCT FROM expected_sha256 THEN
    RAISE EXCEPTION
      'SEC-CERP-0005 preflight: registered checksum mismatch (expected %, found %)',
      expected_sha256,
      registered_sha256;
  END IF;

  IF registry_entry_exists AND (NOT target_table_exists OR NOT target_index_exists) THEN
    RAISE EXCEPTION 'SEC-CERP-0005 preflight: patch is registered but its table or index is missing';
  END IF;

  IF target_table_exists THEN
    SELECT array_agg(required.column_name ORDER BY required.column_name)
      INTO missing_columns
    FROM (
      VALUES
        ('scope'),
        ('subject_hash'),
        ('request_count'),
        ('window_started_at'),
        ('expires_at'),
        ('updated_at')
    ) AS required(column_name)
    WHERE NOT EXISTS (
      SELECT 1
      FROM information_schema.columns existing
      WHERE existing.table_schema = 'public'
        AND existing.table_name = 'auth_rate_limit_buckets'
        AND existing.column_name = required.column_name
    );

    IF missing_columns IS NOT NULL THEN
      RAISE EXCEPTION 'SEC-CERP-0005 preflight: incompatible existing table, missing %', missing_columns;
    END IF;
  END IF;
END
$preflight$;

SELECT
  current_database() AS database_name,
  to_regclass('public.auth_rate_limit_buckets') AS existing_table,
  to_regclass('public.auth_rate_limit_buckets_expires_at_idx') AS existing_index,
  to_regclass('public.cerp_schema_migrations') AS migration_registry,
  'SEC-CERP-0005 preflight passed (read-only)' AS result;
