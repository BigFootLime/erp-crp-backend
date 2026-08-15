-- Read-only SOL-30 preflight. Run only after a verified backup.
DO $preflight$
DECLARE
  missing text[] := ARRAY[]::text[];
BEGIN
  IF current_setting('server_version_num')::integer < 140000 THEN
    RAISE EXCEPTION 'SOL-30 preflight: PostgreSQL 14 or newer is required';
  END IF;
  IF to_regclass('public.users') IS NULL THEN missing := array_append(missing, 'users'); END IF;
  IF to_regclass('public.articles') IS NULL THEN missing := array_append(missing, 'articles'); END IF;
  IF to_regclass('public.lots') IS NULL THEN missing := array_append(missing, 'lots'); END IF;
  IF to_regclass('public.emplacements') IS NULL THEN missing := array_append(missing, 'emplacements'); END IF;
  IF to_regclass('public.ordres_fabrication') IS NULL THEN missing := array_append(missing, 'ordres_fabrication'); END IF;
  IF to_regclass('public.commande_fournisseur') IS NULL THEN missing := array_append(missing, 'commande_fournisseur'); END IF;
  IF to_regclass('public.receptions_fournisseurs') IS NULL THEN missing := array_append(missing, 'receptions_fournisseurs'); END IF;
  IF to_regclass('public.quality_control') IS NULL THEN missing := array_append(missing, 'quality_control'); END IF;
  IF to_regclass('public.gestion_outils_outil') IS NULL THEN missing := array_append(missing, 'gestion_outils_outil'); END IF;
  IF to_regclass('public.bon_livraison') IS NULL THEN missing := array_append(missing, 'bon_livraison'); END IF;
  IF cardinality(missing) > 0 THEN
    RAISE EXCEPTION 'SOL-30 preflight: missing relation(s): %', array_to_string(missing, ', ');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'gen_random_uuid' AND pg_function_is_visible(oid)) THEN
    RAISE EXCEPTION 'SOL-30 preflight: gen_random_uuid() is unavailable';
  END IF;
END
$preflight$;

SELECT current_database() AS database_name,
       current_setting('server_version') AS postgres_version,
       pg_database_size(current_database()) AS database_size_bytes,
       (SELECT count(*) FROM public.users) AS user_count,
       now() AS checked_at;
