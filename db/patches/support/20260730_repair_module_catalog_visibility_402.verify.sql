-- Vérification post-application — réparation catalogue de visibilité #402.
\set ON_ERROR_STOP on

DO $verify_guard$
BEGIN
  IF current_database() NOT IN ('cerp_test', 'cerp_prod') THEN
    RAISE EXCEPTION 'catalogue #402 refusé hors cerp_test/cerp_prod (base actuelle : %)', current_database();
  END IF;
END
$verify_guard$;

SELECT
  current_database() AS database_name,
  EXISTS (SELECT 1 FROM public.app_modules
    WHERE module_key = 'pieces-techniques'
      AND api_prefixes = ARRAY['/pieces-techniques', '/piece-technique-versions', '/gammes', '/dossiers']
      AND nav_page_keys = ARRAY['pieces-techniques']
  ) AS pieces_techniques_catalog_complete,
  EXISTS (SELECT 1 FROM public.app_modules
    WHERE module_key = 'finitions'
      AND api_prefixes = ARRAY['/finitions']
      AND nav_page_keys = ARRAY['finitions']
      AND is_protected = false
  ) AS finitions_catalog_complete,
  EXISTS (SELECT 1 FROM public.app_modules
    WHERE module_key = 'methodes-centres-frais'
      AND api_prefixes = ARRAY['/methodes/centres-frais', '/centre-frais']
      AND nav_page_keys = ARRAY['methodes-centres-frais']
      AND is_protected = false
  ) AS cost_centers_catalog_complete,
  EXISTS (SELECT 1 FROM public.app_modules
    WHERE module_key = 'methodes-parc-machines'
      AND api_prefixes = ARRAY['/methodes/machines', '/methodes/familles-machine']
      AND nav_page_keys = ARRAY['methodes-parc-machines']
      AND is_protected = false
  ) AS machine_park_catalog_complete,
  EXISTS (
    SELECT 1 FROM public.app_modules
    WHERE module_key = 'ged'
      AND '/ged' = ANY (api_prefixes)
      AND 'ged' = ANY (nav_page_keys)
      AND is_protected = false
  ) AS ged_catalog_complete,
  (
    SELECT count(*)::int
    FROM public.app_module_user_access
    WHERE module_key IN (
      'pieces-techniques', 'finitions', 'methodes-centres-frais', 'methodes-parc-machines', 'ged'
    )
  ) AS named_overrides_after;

-- Contrôle d'hygiène : aucun tableau de catalogue ne doit introduire de doublon.
SELECT
  module_key,
  cardinality(api_prefixes) AS api_prefixes_count,
  (SELECT count(DISTINCT value) FROM unnest(api_prefixes) AS value) AS api_prefixes_distinct,
  cardinality(nav_page_keys) AS nav_page_keys_count,
  (SELECT count(DISTINCT value) FROM unnest(nav_page_keys) AS value) AS nav_page_keys_distinct
FROM public.app_modules
WHERE module_key IN ('pieces-techniques', 'finitions', 'methodes-centres-frais', 'methodes-parc-machines', 'ged')
ORDER BY module_key;
