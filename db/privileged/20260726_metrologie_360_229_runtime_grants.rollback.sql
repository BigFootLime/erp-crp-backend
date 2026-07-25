-- Emergency rollback for #229 runtime grants.
-- PRIVILEGED — SUPERUSER ONLY.
--
-- This restores conventional cerp_app ownership and therefore weakens the
-- append-only ownership boundary. Use only as part of an approved rollback.

BEGIN;

DO $guard$
BEGIN
  IF NOT COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false) THEN
    RAISE EXCEPTION
      'metrologie_360_229_runtime_grants rollback: superuser required; current_user=%',
      current_user;
  END IF;
END
$guard$;

DO $rollback$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'metrologie_categories',
    'metrologie_plan_version',
    'metrologie_execution',
    'metrologie_execution_measurement',
    'metrologie_measurement_revision',
    'metrologie_impact_dossier',
    'metrologie_impact_item',
    'metrologie_command_receipts',
    'metrologie_event_log'
  ]
  LOOP
    IF to_regclass('public.' || table_name) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I OWNER TO cerp_app', table_name);
      EXECUTE format('GRANT ALL ON TABLE public.%I TO cerp_app', table_name);
    END IF;
  END LOOP;
END
$rollback$;

ALTER FUNCTION public.fn_protect_metrologie_equipement_229() OWNER TO cerp_app;
ALTER FUNCTION public.fn_protect_metrologie_plan_version_229() OWNER TO cerp_app;
ALTER FUNCTION public.fn_protect_metrologie_execution_229() OWNER TO cerp_app;
ALTER FUNCTION public.fn_protect_metrologie_measurement_229() OWNER TO cerp_app;
ALTER FUNCTION public.fn_protect_metrologie_certificat_229() OWNER TO cerp_app;
ALTER FUNCTION public.fn_metrologie_append_only_229() OWNER TO cerp_app;
ALTER FUNCTION public.fn_protect_metrologie_categorie_229() OWNER TO cerp_app;
ALTER FUNCTION public.fn_protect_metrologie_impact_229() OWNER TO cerp_app;
ALTER FUNCTION public.fn_protect_metrologie_impact_item_229() OWNER TO cerp_app;

COMMIT;
