\set ON_ERROR_STOP on

DO $preflight$
DECLARE
  missing text[] := ARRAY[]::text[];
BEGIN
  IF current_setting('server_version_num')::integer < 140000 THEN
    RAISE EXCEPTION 'EINV-599 requires PostgreSQL 14 or newer';
  END IF;
  IF to_regclass('public.facture') IS NULL THEN missing := array_append(missing, 'public.facture'); END IF;
  IF to_regclass('public.clients') IS NULL THEN missing := array_append(missing, 'public.clients'); END IF;
  IF to_regclass('public.fournisseurs') IS NULL THEN missing := array_append(missing, 'public.fournisseurs'); END IF;
  IF to_regclass('public.finance_legal_mentions') IS NULL THEN missing := array_append(missing, 'public.finance_legal_mentions'); END IF;
  IF cardinality(missing) > 0 THEN
    RAISE EXCEPTION 'EINV-599 missing prerequisites: %', array_to_string(missing, ', ');
  END IF;
END
$preflight$;

SELECT
  current_database() AS database_name,
  current_setting('server_version') AS postgres_version,
  pg_size_pretty(pg_database_size(current_database())) AS database_size,
  (SELECT count(*) FROM public.facture) AS invoice_count,
  now() AS checked_at;
