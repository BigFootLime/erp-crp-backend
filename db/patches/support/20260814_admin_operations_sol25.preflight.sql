\set ON_ERROR_STOP on

DO $preflight$
BEGIN
  IF current_setting('server_version_num')::integer < 140000 THEN
    RAISE EXCEPTION 'SOL-25 requires PostgreSQL 14 or newer';
  END IF;
  IF to_regclass('public.users') IS NULL THEN
    RAISE EXCEPTION 'Missing prerequisite table public.users';
  END IF;
  IF to_regclass('public.auth_login_logs') IS NULL THEN
    RAISE EXCEPTION 'Missing prerequisite table public.auth_login_logs';
  END IF;
  IF to_regclass('public.user_role_assignments') IS NULL THEN
    RAISE EXCEPTION 'Missing prerequisite table public.user_role_assignments';
  END IF;
  IF to_regclass('public.erp_audit_logs') IS NULL THEN
    RAISE EXCEPTION 'Missing prerequisite table public.erp_audit_logs';
  END IF;
  IF to_regclass('public.app_modules') IS NULL OR to_regclass('public.app_module_user_access') IS NULL THEN
    RAISE EXCEPTION 'Missing access-control prerequisites (20260727_admin_access_tower_326.sql)';
  END IF;
  IF to_regclass('public.app_notifications') IS NULL THEN
    RAISE EXCEPTION 'Missing notification prerequisite (20260312_planning_notifications_ar.sql)';
  END IF;
  IF to_regclass('public.data_import_batches') IS NULL OR to_regclass('public.data_import_rows') IS NULL THEN
    RAISE EXCEPTION 'Missing import staging prerequisite (20260726_import_assistant_167.sql)';
  END IF;
  IF to_regprocedure('public.gen_random_uuid()') IS NULL THEN
    RAISE EXCEPTION 'gen_random_uuid() is unavailable; install pgcrypto before SOL-25';
  END IF;
END
$preflight$;

SELECT
  current_database() AS database,
  current_setting('server_version') AS postgres_version,
  pg_size_pretty(pg_database_size(current_database())) AS database_size,
  pg_size_pretty(pg_total_relation_size('public.app_notifications')) AS notification_table_size,
  (SELECT count(*) FROM public.users) AS users_to_snapshot,
  (SELECT count(*) FROM public.app_notifications) AS existing_notifications,
  (SELECT count(*) FROM public.data_import_batches) AS existing_import_batches;
