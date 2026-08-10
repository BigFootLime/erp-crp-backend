-- Preflight non destructif — raccourcis Stock OLD/NEW #446.
\set ON_ERROR_STOP on

BEGIN TRANSACTION READ ONLY;

DO $preflight$
BEGIN
  IF current_database() NOT IN ('cerp_test', 'cerp_prod') THEN
    RAISE EXCEPTION 'navigation #446 refusée hors cerp_test/cerp_prod (base actuelle : %)', current_database();
  END IF;

  IF to_regclass('public.app_modules') IS NULL THEN
    RAISE EXCEPTION
      'navigation #446 : public.app_modules absent — appliquer 20260727_admin_access_tower_326.sql d''abord';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'app_modules'
      AND column_name IN ('module_key', 'nav_page_keys', 'updated_at')
    GROUP BY table_schema, table_name
    HAVING count(*) = 3
  ) THEN
    RAISE EXCEPTION 'navigation #446 : public.app_modules a une forme incompatible';
  END IF;

  IF (SELECT count(*) FROM public.app_modules WHERE module_key = 'stock') <> 1 THEN
    RAISE EXCEPTION 'navigation #446 : le module stock doit exister exactement une fois';
  END IF;
END
$preflight$;

SELECT
  current_database() AS database_name,
  nav_page_keys AS stock_nav_page_keys_before
FROM public.app_modules
WHERE module_key = 'stock';

COMMIT;
