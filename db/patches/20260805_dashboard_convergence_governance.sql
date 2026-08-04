-- Dashboard ARIANE/V2/Legacy convergence governance.
-- Additive only: both kill-switches are created OFF (fail-closed), and no
-- dashboard surface or browser preference is removed by this patch.

DO $preexisting_guard$
BEGIN
  IF to_regclass('public.dashboard_usage_daily') IS NOT NULL
     OR to_regprocedure('public.prune_dashboard_usage_daily(integer)') IS NOT NULL THEN
    RAISE EXCEPTION 'dashboard convergence artifact already exists without this migration ledger entry';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.app_feature_flags
    WHERE key IN ('DASHBOARD_ARIANE_DEFAULT', 'DASHBOARD_USAGE_METRICS')
  ) THEN
    RAISE EXCEPTION 'dashboard convergence feature flag already exists without this migration ledger entry';
  END IF;
END
$preexisting_guard$;

CREATE TABLE public.dashboard_usage_daily (
  usage_date date NOT NULL DEFAULT CURRENT_DATE,
  experience text NOT NULL,
  event_type text NOT NULL,
  selection_source text NOT NULL,
  previous_experience text NOT NULL DEFAULT 'none',
  role_bucket text NOT NULL,
  event_count bigint NOT NULL DEFAULT 0,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dashboard_usage_daily_pkey PRIMARY KEY (
    usage_date, experience, event_type, selection_source, previous_experience, role_bucket
  ),
  CONSTRAINT dashboard_usage_daily_experience_ck CHECK (experience IN ('ariane','v2','legacy')),
  CONSTRAINT dashboard_usage_daily_event_ck CHECK (event_type IN ('view','switch','deep_link','preference_migrated','fallback')),
  CONSTRAINT dashboard_usage_daily_source_ck CHECK (selection_source IN ('default','preference','query','switch','rollback','migration')),
  CONSTRAINT dashboard_usage_daily_previous_ck CHECK (previous_experience IN ('none','ariane','v2','legacy')),
  CONSTRAINT dashboard_usage_daily_role_ck CHECK (role_bucket IN ('direction','production','achats','qualite','operateur')),
  CONSTRAINT dashboard_usage_daily_count_ck CHECK (event_count >= 0)
);

COMMENT ON TABLE public.dashboard_usage_daily IS
  'Agrégats journaliers indicatifs de convergence; aucun user_id, IP, URL, user-agent, identifiant de session ou texte libre.';

CREATE FUNCTION public.prune_dashboard_usage_daily(p_retention_days integer DEFAULT 90)
RETURNS bigint
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $retention$
DECLARE
  deleted_rows bigint;
BEGIN
  IF p_retention_days IS DISTINCT FROM 90 THEN
    RAISE EXCEPTION 'dashboard usage retention is fixed at 90 days';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('dashboard_usage_daily_retention'));
  DELETE FROM public.dashboard_usage_daily
  WHERE usage_date < (CURRENT_DATE - p_retention_days);
  GET DIAGNOSTICS deleted_rows = ROW_COUNT;
  RETURN deleted_rows;
END
$retention$;

COMMENT ON FUNCTION public.prune_dashboard_usage_daily(integer) IS
  'Maintenance indépendante du trafic: purge les agrégats dashboard âgés de plus de 90 jours.';

INSERT INTO public.app_feature_flags (key, name, description, enabled, environment)
VALUES
  (
    'DASHBOARD_ARIANE_DEFAULT',
    'ARIANE par défaut',
    'Kill-switch global prioritaire. OFF force V2, y compris face aux overrides utilisateur et aux deep links ARIANE.',
    false,
    'all'
  ),
  (
    'DASHBOARD_USAGE_METRICS',
    'Mesure indicative de convergence dashboard',
    'OFF jusqu’aux validations DPO/Product/QA et à la preuve de maintenance quotidienne des agrégats à 90 jours.',
    false,
    'all'
  );

ALTER TABLE public.dashboard_usage_daily OWNER TO cerp_app;
REVOKE ALL ON TABLE public.dashboard_usage_daily FROM PUBLIC;
REVOKE ALL ON TABLE public.dashboard_usage_daily FROM cerp_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.dashboard_usage_daily TO cerp_app;

ALTER FUNCTION public.prune_dashboard_usage_daily(integer) OWNER TO cerp_app;
REVOKE ALL ON FUNCTION public.prune_dashboard_usage_daily(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.prune_dashboard_usage_daily(integer) TO cerp_app;
