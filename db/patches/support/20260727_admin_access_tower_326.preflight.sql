-- Lecture seule — prérequis de la tour de contrôle des accès #326 / back #200.
\set ON_ERROR_STOP on

DO $$
BEGIN
  IF current_database() NOT IN ('cerp_test', 'cerp_prod') THEN
    RAISE EXCEPTION 'Base inattendue pour #326 : %', current_database();
  END IF;

  IF to_regclass('public.users') IS NULL THEN
    RAISE EXCEPTION 'Table prérequise public.users absente';
  END IF;

  IF to_regclass('public.erp_audit_logs') IS NULL THEN
    RAISE EXCEPTION 'Table prérequise public.erp_audit_logs absente (audit des mutations)';
  END IF;

  -- Un objet homonyme préexistant d'une autre origine rendrait le patch trompeur :
  -- CREATE TABLE IF NOT EXISTS le laisserait en place sans rien signaler.
  IF to_regclass('public.app_modules') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'app_modules'
         AND column_name = 'enabled_by_default'
     ) THEN
    RAISE EXCEPTION 'public.app_modules existe déjà avec une forme incompatible';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'users'
      AND column_name = 'is_superadmin'
      AND data_type <> 'boolean'
  ) THEN
    RAISE EXCEPTION 'public.users.is_superadmin existe déjà dans un type incompatible';
  END IF;
END $$;

SELECT
  current_database() AS database_name,
  to_regclass('public.app_modules') IS NOT NULL AS app_modules_already_present,
  to_regclass('public.app_module_user_access') IS NOT NULL AS user_access_already_present,
  to_regclass('public.app_module_access_events') IS NOT NULL AS events_already_present,
  EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'is_superadmin'
  ) AS is_superadmin_already_present,
  (SELECT COUNT(*)::int FROM public.users) AS user_count,
  EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') AS runtime_role_present;
