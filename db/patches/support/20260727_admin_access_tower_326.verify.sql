-- Vérification post-application — tour de contrôle des accès #326 / back #200.
\set ON_ERROR_STOP on

SELECT
  current_database() AS database_name,
  to_regclass('public.app_modules') IS NOT NULL AS app_modules_exists,
  to_regclass('public.app_module_user_access') IS NOT NULL AS user_access_exists,
  to_regclass('public.app_module_access_events') IS NOT NULL AS events_exists,
  EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'users'
      AND column_name = 'is_superadmin'
      AND data_type = 'boolean'
      AND is_nullable = 'NO'
  ) AS is_superadmin_column_ok,
  (SELECT COUNT(*)::int FROM public.app_modules) AS modules_total,
  (SELECT COUNT(*)::int FROM public.app_modules WHERE is_active) AS modules_active,
  (SELECT COUNT(*)::int FROM public.app_modules WHERE is_protected) AS modules_protected,
  (
    SELECT COUNT(*)::int
    FROM public.app_modules
    WHERE cardinality(api_prefixes) = 0
  ) AS modules_without_api_prefix,
  (SELECT COUNT(*)::int FROM public.users WHERE is_superadmin) AS superadmin_count,
  (
    SELECT COUNT(*)::int
    FROM public.app_module_user_access a
    JOIN public.app_modules m ON m.module_key = a.module_key
    WHERE m.is_protected AND a.access = 'DENIED'
  ) AS protected_module_denials,
  EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgrelid = 'public.app_module_access_events'::regclass
      AND tgname = 'trg_app_module_access_events_append_only'
      AND NOT tgisinternal
  ) AS events_append_only_trigger,
  (
    NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app')
    OR (
      has_table_privilege('cerp_app', 'public.app_modules', 'SELECT')
      AND NOT has_table_privilege('cerp_app', 'public.app_modules', 'INSERT')
      AND NOT has_table_privilege('cerp_app', 'public.app_modules', 'DELETE')
      AND has_column_privilege('cerp_app', 'public.app_modules', 'enabled_by_default', 'UPDATE')
      AND NOT has_column_privilege('cerp_app', 'public.app_modules', 'module_key', 'UPDATE')
      AND has_table_privilege('cerp_app', 'public.app_module_user_access', 'SELECT,INSERT,UPDATE,DELETE')
      AND has_table_privilege('cerp_app', 'public.app_module_access_events', 'SELECT,INSERT')
      AND NOT has_table_privilege('cerp_app', 'public.app_module_access_events', 'UPDATE,DELETE')
    )
  ) AS application_privileges_ok;

-- Le catalogue attendu doit être complet : toute clé manquante casserait le gate,
-- qui résout le module par préfixe d'API avant d'interroger la base.
SELECT array_agg(expected.module_key ORDER BY expected.module_key) AS missing_module_keys
FROM (
  VALUES
    ('clients'), ('devis'), ('commandes-clients'), ('livraisons'), ('affaires'),
    ('facturation'), ('reporting-commercial'), ('fournisseurs'), ('commandes-fournisseurs'),
    ('pieces-techniques'), ('production'), ('qualite'), ('metrologie'), ('tracabilite'),
    ('stock'), ('outillage'), ('temps-deplacements'), ('pilotage-projet'),
    ('import-clipper'), ('administration')
) AS expected(module_key)
LEFT JOIN public.app_modules m ON m.module_key = expected.module_key
WHERE m.module_key IS NULL;
