-- Vérification non destructive — raccourcis Stock OLD/NEW #446.
\set ON_ERROR_STOP on

BEGIN TRANSACTION READ ONLY;

DO $verify$
DECLARE
  keys text[];
BEGIN
  IF current_database() NOT IN ('cerp_test', 'cerp_prod') THEN
    RAISE EXCEPTION 'navigation #446 refusée hors cerp_test/cerp_prod (base actuelle : %)', current_database();
  END IF;

  SELECT nav_page_keys INTO keys
  FROM public.app_modules
  WHERE module_key = 'stock';

  IF keys IS NULL
     OR NOT ('stock-base-old' = ANY (keys))
     OR NOT ('stock-base-new' = ANY (keys)) THEN
    RAISE EXCEPTION 'navigation #446 : raccourcis OLD/NEW absents du module stock';
  END IF;

  IF cardinality(keys) <> (SELECT count(DISTINCT value) FROM unnest(keys) AS value) THEN
    RAISE EXCEPTION 'navigation #446 : doublon détecté dans les clés du module stock';
  END IF;
END
$verify$;

SELECT current_database() AS database_name, nav_page_keys
FROM public.app_modules
WHERE module_key = 'stock';

COMMIT;
