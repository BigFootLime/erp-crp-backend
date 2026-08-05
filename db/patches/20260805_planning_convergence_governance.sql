-- Premium / legacy planning convergence governance.
-- Additive only: the legacy dashboard board and all planning data remain in
-- place. Both flags start OFF, so the baseline is behaviorally inert.

DO $preexisting_guard$
BEGIN
  IF to_regclass('public.planning_surface_usage_daily') IS NOT NULL
     OR to_regprocedure('public.prune_planning_surface_usage_daily(integer)') IS NOT NULL THEN
    RAISE EXCEPTION 'planning convergence artifact already exists without this migration ledger entry';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.app_feature_flags
    WHERE key IN ('PLANNING_LEGACY_DASHBOARD_RETIREMENT', 'PLANNING_USAGE_METRICS')
  ) THEN
    RAISE EXCEPTION 'planning convergence feature flag already exists without this migration ledger entry';
  END IF;
END
$preexisting_guard$;

CREATE TABLE public.planning_surface_usage_daily (
  usage_date date NOT NULL DEFAULT CURRENT_DATE,
  surface text NOT NULL,
  event_type text NOT NULL,
  browser_family text NOT NULL,
  role_bucket text NOT NULL,
  event_count bigint NOT NULL DEFAULT 0,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT planning_surface_usage_daily_pkey PRIMARY KEY (
    usage_date, surface, event_type, browser_family, role_bucket
  ),
  CONSTRAINT planning_surface_usage_daily_surface_ck CHECK (
    surface IN ('premium_route','legacy_dashboard')
  ),
  CONSTRAINT planning_surface_usage_daily_event_ck CHECK (
    event_type IN ('view','open_premium')
  ),
  CONSTRAINT planning_surface_usage_daily_browser_ck CHECK (
    browser_family IN ('chromium','firefox','webkit','other')
  ),
  CONSTRAINT planning_surface_usage_daily_role_ck CHECK (
    role_bucket IN ('direction','planification','production','atelier','secretariat','other')
  ),
  CONSTRAINT planning_surface_usage_daily_count_ck CHECK (event_count >= 0)
);

COMMENT ON TABLE public.planning_surface_usage_daily IS
  'Daily indicative planning-surface counters; no user_id, IP, URL, raw user-agent, session identifier or free text.';

CREATE FUNCTION public.prune_planning_surface_usage_daily(p_retention_days integer DEFAULT 90)
RETURNS bigint
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $retention$
DECLARE
  deleted_rows bigint;
BEGIN
  IF p_retention_days IS DISTINCT FROM 90 THEN
    RAISE EXCEPTION 'planning usage retention is fixed at 90 days';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('planning_surface_usage_daily_retention'));
  DELETE FROM public.planning_surface_usage_daily
  WHERE usage_date < (CURRENT_DATE - p_retention_days);
  GET DIAGNOSTICS deleted_rows = ROW_COUNT;
  RETURN deleted_rows;
END
$retention$;

COMMENT ON FUNCTION public.prune_planning_surface_usage_daily(integer) IS
  'Independent maintenance job for planning aggregates older than 90 days.';

INSERT INTO public.app_feature_flags (key, name, description, enabled, environment)
VALUES
  (
    'PLANNING_LEGACY_DASHBOARD_RETIREMENT',
    'Retrait du planning dashboard historique',
    'Rollback switch. Must remain OFF while REMOVE-CERP-0004 is NO-GO; code approval and signed parity evidence are also required.',
    false,
    'all'
  ),
  (
    'PLANNING_USAGE_METRICS',
    'Mesure indicative des surfaces planning',
    'OFF until DPO, Product and QA approve aggregate collection and prove the independent 90-day retention job.',
    false,
    'all'
  );

ALTER TABLE public.planning_surface_usage_daily OWNER TO cerp_app;
REVOKE ALL ON TABLE public.planning_surface_usage_daily FROM PUBLIC;
REVOKE ALL ON TABLE public.planning_surface_usage_daily FROM cerp_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.planning_surface_usage_daily TO cerp_app;

ALTER FUNCTION public.prune_planning_surface_usage_daily(integer) OWNER TO cerp_app;
REVOKE ALL ON FUNCTION public.prune_planning_surface_usage_daily(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.prune_planning_surface_usage_daily(integer) TO cerp_app;
