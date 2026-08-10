-- SOL-06 — reference-data readiness gate for critical business flows.
--
-- This patch is additive and transactional. It does not invent operational
-- values. The stock valuation policy must already be present in erp_settings
-- as a source-backed JSON document; the preflight refuses the migration when
-- it is missing or incomplete.

BEGIN;

DO $prerequisites$
BEGIN
  IF to_regclass('public.erp_settings') IS NULL
     OR to_regclass('public.units') IS NULL
     OR to_regclass('public.warehouses') IS NULL
     OR to_regclass('public.locations') IS NULL
     OR to_regclass('public.magasins') IS NULL
     OR to_regclass('public.emplacements') IS NULL
     OR to_regclass('public.programmation_calendars') IS NULL
     OR to_regclass('public.centres_frais') IS NULL
     OR to_regclass('public.production_cost_center_rates') IS NULL
     OR to_regclass('public.app_roles') IS NULL
     OR to_regclass('public.user_role_assignments') IS NULL THEN
    RAISE EXCEPTION 'SOL-06: required reference-data relations are missing; run the migration preflight';
  END IF;
END
$prerequisites$;

ALTER TABLE public.erp_settings
  ADD COLUMN IF NOT EXISTS definition text,
  ADD COLUMN IF NOT EXISTS unit text,
  ADD COLUMN IF NOT EXISTS period_start date,
  ADD COLUMN IF NOT EXISTS period_end date,
  ADD COLUMN IF NOT EXISTS source text,
  ADD COLUMN IF NOT EXISTS freshness_at timestamptz,
  ADD COLUMN IF NOT EXISTS reliability text;

DO $constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.erp_settings'::regclass
      AND conname = 'erp_settings_reference_period_ck'
  ) THEN
    ALTER TABLE public.erp_settings
      ADD CONSTRAINT erp_settings_reference_period_ck
      CHECK (period_end IS NULL OR period_start IS NULL OR period_end >= period_start);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.erp_settings'::regclass
      AND conname = 'erp_settings_reference_reliability_ck'
  ) THEN
    ALTER TABLE public.erp_settings
      ADD CONSTRAINT erp_settings_reference_reliability_ck
      CHECK (reliability IS NULL OR reliability IN ('VERIFIED', 'DECLARED', 'ESTIMATED', 'TEST_ONLY'));
  END IF;
END
$constraints$;

UPDATE public.erp_settings
SET
  value_text = COALESCE(NULLIF(btrim(value_text), ''), value_json->>'method'),
  definition = value_json->>'definition',
  unit = value_json->>'unit',
  period_start = (value_json->>'period_start')::date,
  period_end = NULLIF(value_json->>'period_end', '')::date,
  source = value_json->>'source',
  freshness_at = (value_json->>'freshness_at')::timestamptz,
  reliability = value_json->>'reliability',
  updated_at = now()
WHERE key = 'stock.valuation_method';

CREATE OR REPLACE FUNCTION public.fn_business_prerequisite_status(p_flow text)
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
), checks AS (
  SELECT
    'COMMON'::text AS scope,
    'ACTIVE_ROLES'::text AS prerequisite_code,
    (
      EXISTS (SELECT 1 FROM public.app_roles WHERE is_active)
      AND NOT EXISTS (
        SELECT 1
        FROM public.users u
        WHERE u.status = 'Active'
          AND NOT EXISTS (
            SELECT 1
            FROM public.user_role_assignments ura
            JOIN public.app_roles r ON r.role_key = ura.role_key AND r.is_active
            WHERE ura.user_id = u.id AND ura.role_key = u.role
          )
      )
    ) AS ready,
    'Chaque compte actif possède un rôle principal issu du catalogue actif.'::text AS definition,
    'comptes'::text AS unit,
    CURRENT_DATE AS period_start,
    NULL::date AS period_end,
    'public.app_roles + public.user_role_assignments'::text AS source,
    now() AS freshness_at,
    'VERIFIED'::text AS reliability,
    jsonb_build_object(
      'active_roles', (SELECT count(*) FROM public.app_roles WHERE is_active),
      'active_users_without_primary_role', (
        SELECT count(*) FROM public.users u
        WHERE u.status = 'Active'
          AND NOT EXISTS (
            SELECT 1 FROM public.user_role_assignments ura
            JOIN public.app_roles r ON r.role_key = ura.role_key AND r.is_active
            WHERE ura.user_id = u.id AND ura.role_key = u.role
          )
      )
    ) AS actual_value,
    'au moins un rôle actif; zéro compte actif sans rôle principal'::text AS expected_value,
    'Activez le rôle requis puis affectez le rôle principal dans Administration > Utilisateurs.'::text AS remediation

  UNION ALL
  SELECT
    'COMMON', 'WORKFLOW_STATUSES',
    (
      (SELECT count(DISTINCT e.enumlabel) = 7
       FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
       JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = 'public' AND t.typname = 'of_status'
         AND e.enumlabel = ANY (ARRAY['BROUILLON','PLANIFIE','EN_COURS','EN_PAUSE','TERMINE','CLOTURE','ANNULE']))
      AND EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.stock_movements'::regclass
          AND conname = 'stock_movements_status_check' AND convalidated
      )
    ),
    'Les statuts canoniques OF et stock sont présents et leur contrainte est validée.',
    'contrats', CURRENT_DATE, NULL,
    'pg_catalog.pg_enum + pg_catalog.pg_constraint', now(), 'VERIFIED',
    jsonb_build_object(
      'of_statuses', (SELECT jsonb_agg(e.enumlabel ORDER BY e.enumsortorder)
                      FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
                      JOIN pg_namespace n ON n.oid = t.typnamespace
                      WHERE n.nspname = 'public' AND t.typname = 'of_status'),
      'stock_constraint_validated', EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.stock_movements'::regclass
          AND conname = 'stock_movements_status_check' AND convalidated
      )
    ),
    '7 statuts OF canoniques et contrainte stock validée',
    'Réappliquez les migrations de statuts manquantes et validez la contrainte stock avant reprise.'

  UNION ALL
  SELECT
    'STOCK', 'CANONICAL_UNITS',
    (SELECT count(DISTINCT lower(code)) = 4 FROM public.units WHERE lower(code) = ANY (ARRAY['u','mm','m','kg'])),
    'Unités canoniques utilisables sans conversion implicite.', 'unités', CURRENT_DATE, NULL,
    'public.units', now(), 'VERIFIED',
    (SELECT jsonb_agg(lower(code) ORDER BY lower(code)) FROM public.units WHERE lower(code) = ANY (ARRAY['u','mm','m','kg'])),
    'u, mm, m, kg',
    'Restaurez les unités canoniques via le patch 20260804_article_unit_stock_contract.'

  UNION ALL
  SELECT
    'STOCK', 'ACTIVE_STOCK_LOCATIONS',
    EXISTS (
      SELECT 1 FROM public.locations l
      JOIN public.warehouses w ON w.id = l.warehouse_id
      WHERE l.is_active AND w.is_active
    )
    AND EXISTS (
      SELECT 1 FROM public.emplacements e
      JOIN public.magasins m ON m.id = e.magasin_id
      JOIN public.locations l ON l.id = e.location_id
      JOIN public.warehouses w ON w.id = l.warehouse_id AND w.id = m.warehouse_id
      WHERE e.is_active AND m.is_active AND l.is_active AND w.is_active
    ),
    'Au moins un magasin et un emplacement actifs sont reliés au référentiel warehouse/location.',
    'emplacements', CURRENT_DATE, NULL,
    'public.warehouses + locations + magasins + emplacements', now(), 'VERIFIED',
    jsonb_build_object(
      'active_warehouses', (SELECT count(*) FROM public.warehouses WHERE is_active),
      'active_locations', (SELECT count(*) FROM public.locations WHERE is_active),
      'mapped_active_emplacements', (
        SELECT count(*) FROM public.emplacements e
        JOIN public.magasins m ON m.id = e.magasin_id
        JOIN public.locations l ON l.id = e.location_id
        JOIN public.warehouses w ON w.id = l.warehouse_id AND w.id = m.warehouse_id
        WHERE e.is_active AND m.is_active AND l.is_active AND w.is_active
      )
    ),
    'au moins 1 chaîne active warehouse > magasin > emplacement > location',
    'Configurez un magasin actif et reliez son emplacement à une location du même warehouse.'

  UNION ALL
  SELECT
    'STOCK', 'STOCK_VALUATION_POLICY',
    EXISTS (
      SELECT 1 FROM public.erp_settings s
      WHERE s.key = 'stock.valuation_method'
        AND s.value_text IN ('WEIGHTED_AVERAGE', 'FIFO', 'SPECIFIC_IDENTIFICATION')
        AND s.definition IS NOT NULL AND btrim(s.definition) <> ''
        AND s.unit = 'METHOD'
        AND s.period_start <= CURRENT_DATE
        AND (s.period_end IS NULL OR s.period_end >= CURRENT_DATE)
        AND s.source IS NOT NULL AND btrim(s.source) <> ''
        AND s.freshness_at IS NOT NULL
        AND s.reliability IN ('VERIFIED', 'DECLARED')
    ),
    'Méthode de valorisation de stock applicable à la période courante, sourcée et datée.',
    COALESCE((SELECT unit FROM public.erp_settings WHERE key = 'stock.valuation_method'), 'METHOD'),
    (SELECT period_start FROM public.erp_settings WHERE key = 'stock.valuation_method'),
    (SELECT period_end FROM public.erp_settings WHERE key = 'stock.valuation_method'),
    COALESCE((SELECT source FROM public.erp_settings WHERE key = 'stock.valuation_method'), 'public.erp_settings'),
    (SELECT freshness_at FROM public.erp_settings WHERE key = 'stock.valuation_method'),
    COALESCE((SELECT reliability FROM public.erp_settings WHERE key = 'stock.valuation_method'), 'MISSING'),
    COALESCE((SELECT jsonb_build_object('method', value_text, 'definition', definition)
              FROM public.erp_settings WHERE key = 'stock.valuation_method'), '{}'::jsonb),
    'WEIGHTED_AVERAGE, FIFO ou SPECIFIC_IDENTIFICATION avec métadonnées complètes',
    'Renseignez stock.valuation_method avec définition, unité METHOD, période, source, fraîcheur et fiabilité.'

  UNION ALL
  SELECT
    'PLANNING', 'ACTIVE_PRODUCTION_CALENDAR',
    EXISTS (SELECT 1 FROM public.programmation_calendars WHERE active),
    'Calendrier de capacité actif avec jours et horaires explicites.', 'calendriers', CURRENT_DATE, NULL,
    'public.programmation_calendars', now(), 'VERIFIED',
    jsonb_build_object('active_calendars', (SELECT count(*) FROM public.programmation_calendars WHERE active)),
    'au moins 1 calendrier actif',
    'Créez ou activez un calendrier dans le référentiel Planning avant de planifier.'

  UNION ALL
  SELECT
    'PRODUCTION', 'CURRENT_COST_CENTER_RATES',
    EXISTS (SELECT 1 FROM public.centres_frais WHERE statut = 'ACTIF' AND archived_at IS NULL)
    AND NOT EXISTS (
      SELECT 1 FROM public.centres_frais cf
      WHERE cf.statut = 'ACTIF' AND cf.archived_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM public.production_cost_center_rates rate
          WHERE rate.cf_id = cf.id
            AND rate.date_effet <= CURRENT_DATE
            AND (rate.date_fin IS NULL OR rate.date_fin >= CURRENT_DATE)
            AND rate.taux_horaire >= 0
            AND btrim(rate.source) <> ''
        )
    ),
    'Chaque centre de frais actif possède un taux horaire versionné applicable et sourcé.',
    'EUR/heure', CURRENT_DATE, NULL,
    'public.centres_frais + public.production_cost_center_rates', now(), 'VERIFIED',
    jsonb_build_object(
      'active_cost_centers', (SELECT count(*) FROM public.centres_frais WHERE statut = 'ACTIF' AND archived_at IS NULL),
      'active_cost_centers_without_rate', (
        SELECT count(*) FROM public.centres_frais cf
        WHERE cf.statut = 'ACTIF' AND cf.archived_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM public.production_cost_center_rates rate
            WHERE rate.cf_id = cf.id AND rate.date_effet <= CURRENT_DATE
              AND (rate.date_fin IS NULL OR rate.date_fin >= CURRENT_DATE)
              AND rate.taux_horaire >= 0 AND btrim(rate.source) <> ''
          )
      )
    ),
    'au moins 1 centre actif; zéro centre actif sans taux applicable',
    'Ajoutez un taux daté et sourcé à chaque centre de frais actif, ou archivez le centre inutilisé.'
)
SELECT
  requested.flow,
  checks.prerequisite_code,
  checks.ready,
  checks.definition,
  checks.unit,
  checks.period_start,
  checks.period_end,
  checks.source,
  checks.freshness_at,
  checks.reliability,
  checks.actual_value,
  checks.expected_value,
  checks.remediation
FROM checks CROSS JOIN requested
WHERE checks.scope = 'COMMON'
   OR checks.scope = requested.flow
   OR (requested.flow = 'PRODUCTION' AND checks.scope IN ('PLANNING', 'STOCK') AND checks.prerequisite_code IN ('ACTIVE_PRODUCTION_CALENDAR', 'CANONICAL_UNITS'))
ORDER BY checks.prerequisite_code;
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
  FROM public.fn_business_prerequisite_status(v_flow) status_row
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

DROP TRIGGER IF EXISTS trg_stock_reference_readiness_2606 ON public.stock_movements;
CREATE TRIGGER trg_stock_reference_readiness_2606
BEFORE INSERT OR UPDATE ON public.stock_movements
FOR EACH ROW EXECUTE FUNCTION public.fn_enforce_business_prerequisites('STOCK');

DROP TRIGGER IF EXISTS trg_production_reference_readiness_2606 ON public.ordres_fabrication;
CREATE TRIGGER trg_production_reference_readiness_2606
BEFORE INSERT OR UPDATE OF statut ON public.ordres_fabrication
FOR EACH ROW EXECUTE FUNCTION public.fn_enforce_business_prerequisites('PRODUCTION');

DROP TRIGGER IF EXISTS trg_planning_reference_readiness_2606 ON public.programmations;
CREATE TRIGGER trg_planning_reference_readiness_2606
BEFORE INSERT OR UPDATE ON public.programmations
FOR EACH ROW EXECUTE FUNCTION public.fn_enforce_business_prerequisites('PLANNING');

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    GRANT EXECUTE ON FUNCTION public.fn_business_prerequisite_status(text) TO cerp_app;
    GRANT EXECUTE ON FUNCTION public.fn_enforce_business_prerequisites() TO cerp_app;
  END IF;
END
$grants$;

COMMENT ON FUNCTION public.fn_business_prerequisite_status(text) IS
  'SOL-06 source-backed readiness checks. Each row defines unit, period, source, freshness and reliability.';
COMMENT ON FUNCTION public.fn_enforce_business_prerequisites() IS
  'SOL-06 database-side gate. SQLSTATE P2606 is mapped by the API to an actionable HTTP 409 response.';

COMMIT;
