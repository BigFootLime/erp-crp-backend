-- Read-only. This patch is independent of business-code counter reconciliation #1458.
SELECT current_database() AS database,
 current_database() !~ '^cerp_directory_' AS business_database,
 to_regclass('public.users') IS NOT NULL AS users_installed,
 to_regclass('public.app_modules') IS NOT NULL AS access_control_installed,
 EXISTS(SELECT 1 FROM pg_roles WHERE rolname='cerp_app') AS application_role_installed;
