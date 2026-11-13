-- 20261021_shared_planning_client_color.preflight.sql -- READ ONLY.
-- Run on Test before Prod. It changes no row, schema or migration ledger.

\echo '=== Shared planning client color: preflight ==='
SELECT current_database() AS database, current_user AS role;

SELECT 'clients' AS object, to_regclass('public.clients') IS NOT NULL AS present
UNION ALL SELECT 'planning_user_preferences', to_regclass('public.planning_user_preferences') IS NOT NULL;

SELECT
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='clients' AND column_name='color_hex') AS has_legacy_color_hex,
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='clients' AND column_name='color') AS has_legacy_color,
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='clients' AND column_name='planning_color_hex') AS has_shared_color;

-- Values that will be normalized and retained on the first application.
SELECT
  count(*) FILTER (WHERE upper(btrim(to_jsonb(c)->>'color_hex')) ~ '^#[0-9A-F]{6}$') AS valid_legacy_color_hex,
  count(*) FILTER (WHERE upper(btrim(to_jsonb(c)->>'color')) ~ '^#[0-9A-F]{6}$') AS valid_legacy_color
FROM public.clients c;

