\set ON_ERROR_STOP on
-- Destructive and manual only: export metrics before executing.
DELETE FROM public.app_feature_flags
WHERE key IN ('DASHBOARD_ARIANE_DEFAULT','DASHBOARD_USAGE_METRICS');
DROP TABLE IF EXISTS public.dashboard_usage_daily;
