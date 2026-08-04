\set ON_ERROR_STOP on
SELECT to_regclass('public.dashboard_usage_daily') AS usage_table;
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema='public' AND table_name='dashboard_usage_daily'
ORDER BY ordinal_position;
SELECT key, enabled, environment
FROM public.app_feature_flags
WHERE key IN ('DASHBOARD_ARIANE_DEFAULT','DASHBOARD_USAGE_METRICS')
ORDER BY key;
