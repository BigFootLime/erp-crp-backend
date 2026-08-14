-- SOL-21 — server-side planning preferences for reliable production planning.
-- Additive, transactional and safe to replay. No business value is fabricated.

BEGIN;

DO $preconditions$
BEGIN
  IF current_setting('server_version_num')::integer < 140000 THEN
    RAISE EXCEPTION 'SOL-21 requires PostgreSQL 14 or newer';
  END IF;
  IF to_regclass('public.users') IS NULL
     OR to_regclass('public.planning_events') IS NULL
     OR to_regclass('public.of_operations') IS NULL
     OR to_regclass('public.ordres_fabrication') IS NULL
     OR to_regclass('public.machines') IS NULL
     OR to_regclass('public.postes') IS NULL
     OR to_regclass('public.production_pointages') IS NULL
     OR to_regclass('public.production_activity_categories') IS NULL
     OR to_regclass('public.production_quantity_declarations') IS NULL
     OR to_regclass('public.production_machine_unavailability') IS NULL
     OR to_regclass('public.programmation_calendars') IS NULL
     OR to_regclass('public.programmation_calendar_closures') IS NULL THEN
    RAISE EXCEPTION 'SOL-21 prerequisite relation is missing';
  END IF;
END
$preconditions$;

-- The offline station already records its provenance as OFFLINE_STATION.  The
-- canonical pointage constraint predates that execution path and otherwise
-- rejects the first synchronized START with SQLSTATE 23514.
ALTER TABLE public.production_pointages
  DROP CONSTRAINT IF EXISTS production_pointages_source_sol21_chk;
ALTER TABLE public.production_pointages
  ADD CONSTRAINT production_pointages_source_sol21_chk
  CHECK (source IN ('CANONICAL', 'LEGACY_TIME_LOG', 'RETROACTIVE', 'ADAPTER', 'OFFLINE_STATION'))
  NOT VALID;
ALTER TABLE public.production_pointages
  VALIDATE CONSTRAINT production_pointages_source_sol21_chk;
ALTER TABLE public.production_pointages
  DROP CONSTRAINT IF EXISTS production_pointages_source_chk;
ALTER TABLE public.production_pointages
  RENAME CONSTRAINT production_pointages_source_sol21_chk TO production_pointages_source_chk;

CREATE OR REPLACE FUNCTION public.fn_planning_color_map_is_valid(value jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $function$
BEGIN
  IF jsonb_typeof(value) <> 'object' THEN
    RETURN false;
  END IF;
  RETURN (SELECT count(*) FROM jsonb_object_keys(value)) <= 200
     AND NOT EXISTS (
       SELECT 1
         FROM jsonb_each_text(value) entry
        WHERE char_length(btrim(entry.key)) NOT BETWEEN 1 AND 160
           OR entry.value !~ '^#[0-9A-F]{6}$'
     );
END;
$function$;

CREATE TABLE IF NOT EXISTS public.planning_user_preferences (
  user_id integer PRIMARY KEY REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  timezone text NOT NULL DEFAULT 'Europe/Paris',
  horizon_weeks smallint NOT NULL DEFAULT 6,
  view_mode text NOT NULL DEFAULT 'WEEK',
  show_weekends boolean NOT NULL DEFAULT false,
  machine_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  status_colors jsonb NOT NULL DEFAULT '{}'::jsonb,
  client_color_overrides jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by integer REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  updated_by integer REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  CONSTRAINT planning_user_preferences_timezone_ck CHECK (char_length(btrim(timezone)) BETWEEN 1 AND 80),
  CONSTRAINT planning_user_preferences_horizon_ck CHECK (horizon_weeks BETWEEN 1 AND 13),
  CONSTRAINT planning_user_preferences_view_ck CHECK (view_mode IN ('DAY', 'WEEK', 'MONTH', 'YEAR')),
  CONSTRAINT planning_user_preferences_status_colors_ck CHECK (public.fn_planning_color_map_is_valid(status_colors)),
  CONSTRAINT planning_user_preferences_client_colors_ck CHECK (public.fn_planning_color_map_is_valid(client_color_overrides))
);

DO $trigger$
BEGIN
  IF to_regprocedure('public.tg_set_updated_at()') IS NULL THEN
    RAISE EXCEPTION 'SOL-21 requires public.tg_set_updated_at()';
  END IF;
  DROP TRIGGER IF EXISTS planning_user_preferences_set_updated_at ON public.planning_user_preferences;
  CREATE TRIGGER planning_user_preferences_set_updated_at
    BEFORE UPDATE ON public.planning_user_preferences
    FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
END
$trigger$;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    GRANT SELECT, INSERT, UPDATE ON public.planning_user_preferences TO cerp_app;
    GRANT EXECUTE ON FUNCTION public.fn_planning_color_map_is_valid(jsonb) TO cerp_app;
    -- The station occupancy view is owned by cerp_app and reads machines.
    -- Granting the view alone leaves session opening blocked with SQLSTATE 42501.
    GRANT SELECT ON public.machines TO cerp_app;
  END IF;
END
$grants$;

COMMENT ON TABLE public.planning_user_preferences IS
  'SOL-21 — audited per-user planning preferences. Browser storage is only a cache; this table is authoritative.';
COMMENT ON COLUMN public.planning_user_preferences.client_color_overrides IS
  'Per-user planning color overrides, validated server-side. Never used as a business KPI or machine state.';

COMMIT;
