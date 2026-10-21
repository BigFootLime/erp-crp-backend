-- 20261021_shared_planning_client_color.verify.sql -- READ ONLY, safe to repeat.
-- Run after the patch and before routing traffic to the backend that reads it.

\echo '=== Shared planning client color: verify ==='
SELECT current_database() AS database, current_user AS role;

SELECT
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='clients' AND column_name='planning_color_hex') AS has_shared_color,
  EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.clients'::regclass AND conname='clients_planning_color_hex_ck') AS has_format_constraint;

SELECT
  count(*) AS clients_total,
  count(*) FILTER (WHERE planning_color_hex IS NOT NULL) AS explicitly_colored,
  count(*) FILTER (WHERE planning_color_hex IS NOT NULL AND planning_color_hex !~ '^#[0-9A-F]{6}$') AS invalid_shared_color
FROM public.clients;

