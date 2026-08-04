\set ON_ERROR_STOP on

-- Read-only preflight. Run against cerp_test first, then cerp_prod only after
-- the documented human approval and backup gate.
DO $preflight$
DECLARE
  missing_columns text[];
BEGIN
  IF current_database() NOT IN ('cerp_test', 'cerp_prod') THEN
    RAISE EXCEPTION 'SEC-CERP-0005 preflight: unexpected database %', current_database();
  END IF;

  IF to_regrole('cerp_app') IS NULL THEN
    RAISE EXCEPTION 'SEC-CERP-0005 preflight: role cerp_app is missing';
  END IF;

  IF to_regclass('public.auth_rate_limit_buckets') IS NOT NULL THEN
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
  'SEC-CERP-0005 preflight passed (read-only)' AS result;
