-- SOL-06 follow-up — user-guided production readiness.
-- Additive and transactional. It tightens readiness without creating any
-- calendar, cost centre or hourly rate on behalf of the business.

BEGIN;

DO $preconditions$
BEGIN
  IF to_regprocedure('public.fn_business_prerequisite_status(text)') IS NULL
     OR to_regclass('public.programmation_calendars') IS NULL
     OR to_regclass('public.production_cost_center_rates') IS NULL THEN
    RAISE EXCEPTION 'Production readiness center requires the SOL-06 reference-data patch';
  END IF;
END
$preconditions$;

CREATE OR REPLACE FUNCTION public.fn_business_prerequisite_status_v2(p_flow text)
RETURNS TABLE (
  flow text,
  prerequisite_code text,
  ready boolean,
  definition text,
  unit text,
  period_start date,
  period_end date,
  source text,
  freshness_at timestamptz,
  reliability text,
  actual_value jsonb,
  expected_value text,
  remediation text
)
LANGUAGE sql
STABLE
AS $function$
WITH requested AS (
  SELECT upper(btrim(p_flow)) AS flow
), legacy AS (
  SELECT status.*
  FROM public.fn_business_prerequisite_status(p_flow) status
  WHERE status.prerequisite_code NOT IN ('ACTIVE_PRODUCTION_CALENDAR', 'CURRENT_COST_CENTER_RATES')
), strict_checks AS (
  SELECT
    requested.flow,
    'ACTIVE_PRODUCTION_CALENDAR'::text AS prerequisite_code,
    EXISTS (
      SELECT 1
      FROM public.programmation_calendars calendar
      WHERE calendar.active
        AND cardinality(calendar.working_days) > 0
        AND calendar.day_start < calendar.day_end
    ) AS ready,
    'Calendrier de capacité actif avec jours ouvrés et horaires de début et de fin explicitement renseignés.'::text AS definition,
    'minutes d''ouverture par jour'::text AS unit,
    (SELECT min(calendar.created_at)::date FROM public.programmation_calendars calendar WHERE calendar.active) AS period_start,
    NULL::date AS period_end,
    'public.programmation_calendars — saisie utilisateur auditée'::text AS source,
    (SELECT max(calendar.updated_at) FROM public.programmation_calendars calendar WHERE calendar.active) AS freshness_at,
    'DECLARED'::text AS reliability,
    jsonb_build_object(
      'active_calendars', (SELECT count(*) FROM public.programmation_calendars calendar WHERE calendar.active),
      'complete_active_calendars', (
        SELECT count(*) FROM public.programmation_calendars calendar
        WHERE calendar.active AND cardinality(calendar.working_days) > 0 AND calendar.day_start < calendar.day_end
      )
    ) AS actual_value,
    'au moins 1 calendrier actif avec des jours ouvrés et une plage horaire non nulle'::text AS expected_value,
    'Ouvrez Planning > Calendriers de production, renseignez les jours et horaires réels puis activez le calendrier.'::text AS remediation
  FROM requested
  WHERE requested.flow IN ('PLANNING', 'PRODUCTION')

  UNION ALL

  SELECT
    requested.flow,
    'CURRENT_COST_CENTER_RATES',
    EXISTS (
      SELECT 1 FROM public.centres_frais center
      WHERE center.statut = 'ACTIF' AND center.archived_at IS NULL
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.centres_frais center
      WHERE center.statut = 'ACTIF' AND center.archived_at IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM public.production_cost_center_rates rate
          WHERE rate.cf_id = center.id
            AND rate.date_effet <= CURRENT_DATE
            AND (rate.date_fin IS NULL OR rate.date_fin >= CURRENT_DATE)
            AND rate.taux_horaire > 0
            AND NULLIF(btrim(rate.source), '') IS NOT NULL
        )
    ),
    'Chaque centre de frais actif possède un taux horaire strictement positif, versionné, applicable et sourcé.',
    'EUR/heure',
    CURRENT_DATE,
    NULL,
    'public.centres_frais + public.production_cost_center_rates — saisie utilisateur auditée',
    (
      SELECT max(rate.created_at)
      FROM public.production_cost_center_rates rate
      JOIN public.centres_frais center ON center.id = rate.cf_id
      WHERE center.statut = 'ACTIF' AND center.archived_at IS NULL
        AND rate.date_effet <= CURRENT_DATE
        AND (rate.date_fin IS NULL OR rate.date_fin >= CURRENT_DATE)
    ),
    'DECLARED',
    jsonb_build_object(
      'active_cost_centers', (
        SELECT count(*) FROM public.centres_frais center
        WHERE center.statut = 'ACTIF' AND center.archived_at IS NULL
      ),
      'active_cost_centers_without_valid_rate', (
        SELECT count(*)
        FROM public.centres_frais center
        WHERE center.statut = 'ACTIF' AND center.archived_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM public.production_cost_center_rates rate
            WHERE rate.cf_id = center.id
              AND rate.date_effet <= CURRENT_DATE
              AND (rate.date_fin IS NULL OR rate.date_fin >= CURRENT_DATE)
              AND rate.taux_horaire > 0
              AND NULLIF(btrim(rate.source), '') IS NOT NULL
          )
      )
    ),
    'au moins 1 centre actif; zéro centre actif sans taux positif applicable et sourcé',
    'Ouvrez Méthodes > Centres de frais, créez les centres utiles puis ajoutez un taux réel, daté et sourcé à chacun.'
  FROM requested
  WHERE requested.flow = 'PRODUCTION'
)
SELECT * FROM legacy
UNION ALL
SELECT * FROM strict_checks
ORDER BY prerequisite_code;
$function$;

CREATE OR REPLACE FUNCTION public.fn_enforce_business_prerequisites()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger$
DECLARE
  v_flow text := upper(TG_ARGV[0]);
  v_missing jsonb;
BEGIN
  IF v_flow = 'PRODUCTION'
     AND COALESCE(to_jsonb(NEW)->>'statut', '') NOT IN ('PLANIFIE', 'EN_COURS', 'EN_PAUSE') THEN
    RETURN NEW;
  END IF;

  SELECT jsonb_agg(to_jsonb(status_row) - 'flow' ORDER BY status_row.prerequisite_code)
  INTO v_missing
  FROM public.fn_business_prerequisite_status_v2(v_flow) status_row
  WHERE NOT status_row.ready;

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Référentiels incomplets pour démarrer le flux %', v_flow
      USING
        ERRCODE = 'P2606',
        DETAIL = v_missing::text,
        HINT = 'Corrigez les prérequis listés puis relancez exactement la même commande idempotente.';
  END IF;
  RETURN NEW;
END
$trigger$;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    GRANT SELECT, INSERT, UPDATE ON public.programmation_calendars TO cerp_app;
    GRANT SELECT, INSERT, DELETE ON public.programmation_calendar_closures TO cerp_app;
    GRANT EXECUTE ON FUNCTION public.fn_business_prerequisite_status_v2(text) TO cerp_app;
  END IF;
END
$grants$;

COMMENT ON FUNCTION public.fn_business_prerequisite_status_v2(text) IS
  'SOL-06 guided readiness: explicit calendars and strictly positive current hourly rates; declared user-entered data remains distinguishable from verified system checks.';

COMMIT;
