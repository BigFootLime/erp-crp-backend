-- Read-only SOL-29 preflight. Run after a verified backup.
DO $preflight$
DECLARE
  missing text[] := ARRAY[]::text[];
BEGIN
  IF current_setting('server_version_num')::integer < 140000 THEN
    RAISE EXCEPTION 'SOL-29 preflight: PostgreSQL 14 or newer is required';
  END IF;
  IF to_regclass('public.clients') IS NULL THEN missing := array_append(missing, 'clients'); END IF;
  IF to_regclass('public.users') IS NULL THEN missing := array_append(missing, 'users'); END IF;
  IF to_regclass('public.commande_client') IS NULL THEN missing := array_append(missing, 'commande_client'); END IF;
  IF to_regclass('public.commande_historique') IS NULL THEN missing := array_append(missing, 'commande_historique'); END IF;
  IF to_regclass('public.bon_livraison') IS NULL THEN missing := array_append(missing, 'bon_livraison'); END IF;
  IF to_regclass('public.facture') IS NULL THEN missing := array_append(missing, 'facture'); END IF;
  IF to_regclass('public.ged_documents') IS NULL THEN missing := array_append(missing, 'ged_documents'); END IF;
  IF to_regclass('public.ged_document_versions') IS NULL THEN missing := array_append(missing, 'ged_document_versions'); END IF;
  IF to_regclass('public.ged_upload_sessions') IS NULL THEN missing := array_append(missing, 'ged_upload_sessions'); END IF;
  IF cardinality(missing) > 0 THEN
    RAISE EXCEPTION 'SOL-29 preflight: missing relation(s): %', array_to_string(missing, ', ');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'gen_random_uuid' AND pg_function_is_visible(oid)) THEN
    RAISE EXCEPTION 'SOL-29 preflight: gen_random_uuid() is unavailable';
  END IF;
END
$preflight$;

SELECT current_database() AS database_name,
       current_setting('server_version') AS postgres_version,
       pg_database_size(current_database()) AS database_size_bytes,
       (SELECT count(*) FROM public.clients) AS client_count,
       (SELECT count(*) FROM public.ged_document_versions) AS ged_version_count,
       now() AS checked_at;

