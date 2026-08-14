\set ON_ERROR_STOP on

DO $preflight$
DECLARE
  missing text[] := ARRAY[]::text[];
BEGIN
  IF current_setting('server_version_num')::integer < 140000 THEN
    RAISE EXCEPTION 'SOL-26 requires PostgreSQL 14 or newer';
  END IF;
  IF to_regclass('public.facture') IS NULL THEN missing := array_append(missing, 'public.facture'); END IF;
  IF to_regclass('public.avoir') IS NULL THEN missing := array_append(missing, 'public.avoir'); END IF;
  IF to_regclass('public.users') IS NULL THEN missing := array_append(missing, 'public.users'); END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'facture' AND column_name = 'document_status'
  ) THEN
    missing := array_append(missing, 'public.facture.document_status');
  END IF;
  IF cardinality(missing) > 0 THEN
    RAISE EXCEPTION 'SOL-26 missing prerequisites: %', array_to_string(missing, ', ');
  END IF;
END
$preflight$;

SELECT
  current_database() AS database_name,
  current_setting('server_version') AS postgres_version,
  pg_size_pretty(pg_database_size(current_database())) AS database_size,
  to_regprocedure('gen_random_uuid()') IS NOT NULL AS uuid_generator_available,
  now() AS checked_at;
