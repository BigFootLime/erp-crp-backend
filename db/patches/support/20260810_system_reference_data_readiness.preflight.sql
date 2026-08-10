\set ON_ERROR_STOP on

BEGIN TRANSACTION READ ONLY;

DO $preflight$
DECLARE
  v_setting jsonb;
BEGIN
  IF current_setting('server_version_num')::integer < 140000 THEN
    RAISE EXCEPTION 'SOL-06 preflight: PostgreSQL 14 or newer is required (found %)', version();
  END IF;

  IF EXISTS (
    SELECT 1 FROM unnest(ARRAY['pgcrypto','btree_gist','uuid-ossp','unaccent']) required(name)
    WHERE NOT EXISTS (SELECT 1 FROM pg_extension ext WHERE ext.extname = required.name)
  ) THEN
    RAISE EXCEPTION 'SOL-06 preflight: required PostgreSQL extensions are missing';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE connamespace = 'public'::regnamespace
      AND contype = 'f' AND NOT convalidated
  ) THEN
    RAISE EXCEPTION 'SOL-06 preflight: public foreign keys remain NOT VALID';
  END IF;

  IF EXISTS (SELECT 1 FROM public.units GROUP BY lower(code) HAVING count(*) > 1)
     OR EXISTS (SELECT 1 FROM public.warehouses GROUP BY lower(code) HAVING count(*) > 1)
     OR EXISTS (SELECT 1 FROM public.magasins GROUP BY lower(code) HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'SOL-06 preflight: duplicate canonical reference codes detected';
  END IF;

  SELECT value_json INTO v_setting
  FROM public.erp_settings
  WHERE key = 'stock.valuation_method';

  IF v_setting IS NULL
     OR v_setting->>'method' NOT IN ('WEIGHTED_AVERAGE', 'FIFO', 'SPECIFIC_IDENTIFICATION')
     OR NULLIF(btrim(v_setting->>'definition'), '') IS NULL
     OR v_setting->>'unit' <> 'METHOD'
     OR NULLIF(v_setting->>'period_start', '') IS NULL
     OR (v_setting->>'period_start')::date > CURRENT_DATE
     OR (NULLIF(v_setting->>'period_end', '') IS NOT NULL AND (v_setting->>'period_end')::date < CURRENT_DATE)
     OR NULLIF(btrim(v_setting->>'source'), '') IS NULL
     OR NULLIF(v_setting->>'freshness_at', '') IS NULL
     OR v_setting->>'reliability' NOT IN ('VERIFIED', 'DECLARED') THEN
    RAISE EXCEPTION 'SOL-06 preflight: stock.valuation_method must be current, source-backed and VERIFIED or DECLARED';
  END IF;

  IF (SELECT count(DISTINCT lower(code)) FROM public.units WHERE lower(code) = ANY (ARRAY['u','mm','m','kg'])) <> 4 THEN
    RAISE EXCEPTION 'SOL-06 preflight: canonical units u/mm/m/kg are incomplete';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.emplacements e
    JOIN public.magasins m ON m.id = e.magasin_id
    JOIN public.locations l ON l.id = e.location_id
    JOIN public.warehouses w ON w.id = l.warehouse_id AND w.id = m.warehouse_id
    WHERE e.is_active AND m.is_active AND l.is_active AND w.is_active
  ) THEN
    RAISE EXCEPTION 'SOL-06 preflight: no active warehouse/magasin/emplacement/location chain';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.programmation_calendars WHERE active) THEN
    RAISE EXCEPTION 'SOL-06 preflight: no active production calendar';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.centres_frais WHERE statut = 'ACTIF' AND archived_at IS NULL)
     OR EXISTS (
       SELECT 1 FROM public.centres_frais cf
       WHERE cf.statut = 'ACTIF' AND cf.archived_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM public.production_cost_center_rates rate
           WHERE rate.cf_id = cf.id AND rate.date_effet <= CURRENT_DATE
             AND (rate.date_fin IS NULL OR rate.date_fin >= CURRENT_DATE)
             AND rate.taux_horaire >= 0 AND btrim(rate.source) <> ''
         )
     ) THEN
    RAISE EXCEPTION 'SOL-06 preflight: every active cost center needs a current source-backed hourly rate';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.app_roles WHERE is_active)
     OR EXISTS (
       SELECT 1 FROM public.users u
       WHERE u.status = 'Active'
         AND NOT EXISTS (
           SELECT 1 FROM public.user_role_assignments ura
           JOIN public.app_roles role ON role.role_key = ura.role_key AND role.is_active
           WHERE ura.user_id = u.id AND ura.role_key = u.role
         )
     ) THEN
    RAISE EXCEPTION 'SOL-06 preflight: active user role assignments are incomplete';
  END IF;
END
$preflight$;

SELECT
  current_database() AS database_name,
  current_setting('server_version') AS postgres_version,
  pg_database_size(current_database()) AS database_bytes,
  (SELECT count(*) FROM public.cerp_schema_migrations) AS applied_patches,
  (SELECT count(*) FROM public.units) AS units,
  (SELECT count(*) FROM public.warehouses WHERE is_active) AS active_warehouses,
  (SELECT count(*) FROM public.locations WHERE is_active) AS active_locations,
  (SELECT count(*) FROM public.programmation_calendars WHERE active) AS active_calendars,
  (SELECT count(*) FROM public.centres_frais WHERE statut = 'ACTIF' AND archived_at IS NULL) AS active_cost_centers,
  (SELECT count(*) FROM public.app_roles WHERE is_active) AS active_roles,
  (SELECT value_json FROM public.erp_settings WHERE key = 'stock.valuation_method') AS valuation_policy;

COMMIT;
