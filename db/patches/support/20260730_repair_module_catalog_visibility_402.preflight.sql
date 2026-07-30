-- Préflight non destructif — réparation catalogue de visibilité #402.
\set ON_ERROR_STOP on

DO $preflight$
DECLARE
  technical_module_count integer;
BEGIN
  IF current_database() NOT IN ('cerp_test', 'cerp_prod') THEN
    RAISE EXCEPTION 'catalogue #402 refusé hors cerp_test/cerp_prod (base actuelle : %)', current_database();
  END IF;

  IF to_regclass('public.app_modules') IS NULL THEN
    RAISE EXCEPTION
      'catalogue #402 : public.app_modules absent — appliquer 20260727_admin_access_tower_326.sql d''abord';
  END IF;

  IF to_regclass('public.app_module_user_access') IS NULL THEN
    RAISE EXCEPTION
      'catalogue #402 : public.app_module_user_access absent — appliquer 20260727_admin_access_tower_326.sql d''abord';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'app_modules'
      AND column_name IN (
        'module_key', 'label', 'description', 'category', 'api_prefixes',
        'nav_page_keys', 'enabled_by_default', 'is_active', 'is_protected',
        'sort_order', 'updated_at'
      )
    GROUP BY table_schema, table_name
    HAVING count(*) = 11
  ) THEN
    RAISE EXCEPTION 'catalogue #402 : public.app_modules a une forme incompatible';
  END IF;

  SELECT count(*)::integer
  INTO technical_module_count
  FROM public.app_modules
  WHERE module_key = 'pieces-techniques';

  IF technical_module_count <> 1 THEN
    RAISE EXCEPTION
      'catalogue #402 : le module source pieces-techniques doit exister exactement une fois (trouvé : %)',
      technical_module_count;
  END IF;
END
$preflight$;

SELECT
  current_database() AS database_name,
  (SELECT enabled_by_default FROM public.app_modules WHERE module_key = 'pieces-techniques')
    AS technical_data_enabled_by_default_before,
  (SELECT is_active FROM public.app_modules WHERE module_key = 'pieces-techniques')
    AS technical_data_is_active_before,
  (SELECT enabled_by_default FROM public.app_modules WHERE module_key = 'finitions')
    AS finitions_enabled_by_default_before,
  (SELECT enabled_by_default FROM public.app_modules WHERE module_key = 'methodes-centres-frais')
    AS cost_centers_enabled_by_default_before,
  (SELECT enabled_by_default FROM public.app_modules WHERE module_key = 'methodes-parc-machines')
    AS machine_park_enabled_by_default_before,
  (SELECT enabled_by_default FROM public.app_modules WHERE module_key = 'ged')
    AS ged_enabled_by_default_before,
  (SELECT is_active FROM public.app_modules WHERE module_key = 'ged')
    AS ged_is_active_before,
  (SELECT count(*)::int FROM public.app_module_user_access WHERE module_key IN (
    'pieces-techniques', 'finitions', 'methodes-centres-frais', 'methodes-parc-machines', 'ged'
  ))
    AS preserved_named_overrides_count;
