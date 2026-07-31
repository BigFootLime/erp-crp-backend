\set ON_ERROR_STOP on

SELECT
  to_regclass('public.users') AS users_table,
  to_regclass('public.app_modules') AS modules_table,
  to_regclass('public.app_module_user_access') AS overrides_table,
  to_regclass('public.app_module_access_events') AS events_table;

SELECT
  count(*) FILTER (WHERE upper(trim(username)) = 'KEENAN') AS keenan_accounts,
  count(*) FILTER (WHERE COALESCE(is_superadmin, false)) AS current_superadmins,
  count(*) AS users_total
FROM public.users;

SELECT
  count(*) AS modules_total,
  count(*) FILTER (WHERE NOT enabled_by_default) AS closed_by_default,
  count(*) FILTER (WHERE NOT is_active) AS inactive_modules
FROM public.app_modules;

SELECT
  count(*) AS overrides_total,
  count(*) FILTER (WHERE access = 'DENIED') AS denied_total,
  count(*) FILTER (WHERE access = 'GRANTED') AS granted_total
FROM public.app_module_user_access;
