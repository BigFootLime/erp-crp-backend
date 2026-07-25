-- 20260726_metrologie_360_229_runtime_grants.sql
-- PRIVILEGED — SUPERUSER ONLY
--
-- The #229 patch can be applied either by the patch runner (cerp_app) or
-- directly by postgres during a controlled release. Direct application makes
-- the new tables postgres-owned, so the runtime role would otherwise have no
-- access. This script makes ownership and least-privilege grants reproducible.
--
-- Mutable workflow tables remain postgres-owned and expose only the operations
-- used by the API. Evidence tables are strictly SELECT + INSERT for cerp_app.
--
-- Apply after db/patches/20260726_metrologie_360_229.sql.

BEGIN;

DO $guard$
BEGIN
  IF NOT COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false) THEN
    RAISE EXCEPTION
      'metrologie_360_229_runtime_grants: superuser required; current_user=%',
      current_user;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    RAISE EXCEPTION 'metrologie_360_229_runtime_grants: role cerp_app is missing';
  END IF;
END
$guard$;

DO $mutable_tables$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'metrologie_categories',
    'metrologie_plan_version',
    'metrologie_execution',
    'metrologie_execution_measurement',
    'metrologie_impact_dossier',
    'metrologie_impact_item'
  ]
  LOOP
    IF to_regclass('public.' || table_name) IS NULL THEN
      RAISE EXCEPTION
        'metrologie_360_229_runtime_grants: missing table public.%',
        table_name;
    END IF;

    EXECUTE format('ALTER TABLE public.%I OWNER TO postgres', table_name);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM cerp_app', table_name);
    EXECUTE format(
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.%I FROM PUBLIC',
      table_name
    );
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE ON TABLE public.%I TO cerp_app',
      table_name
    );
  END LOOP;
END
$mutable_tables$;

DO $append_only_tables$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'metrologie_event_log',
    'metrologie_measurement_revision',
    'metrologie_command_receipts'
  ]
  LOOP
    IF to_regclass('public.' || table_name) IS NULL THEN
      RAISE EXCEPTION
        'metrologie_360_229_runtime_grants: missing table public.%',
        table_name;
    END IF;

    EXECUTE format('ALTER TABLE public.%I OWNER TO postgres', table_name);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM cerp_app', table_name);
    EXECUTE format(
      'REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.%I FROM PUBLIC',
      table_name
    );
    EXECUTE format(
      'GRANT SELECT, INSERT ON TABLE public.%I TO cerp_app',
      table_name
    );
  END LOOP;
END
$append_only_tables$;

ALTER FUNCTION public.fn_protect_metrologie_equipement_229() OWNER TO postgres;
ALTER FUNCTION public.fn_protect_metrologie_plan_version_229() OWNER TO postgres;
ALTER FUNCTION public.fn_protect_metrologie_execution_229() OWNER TO postgres;
ALTER FUNCTION public.fn_protect_metrologie_measurement_229() OWNER TO postgres;
ALTER FUNCTION public.fn_protect_metrologie_certificat_229() OWNER TO postgres;
ALTER FUNCTION public.fn_metrologie_append_only_229() OWNER TO postgres;
ALTER FUNCTION public.fn_protect_metrologie_categorie_229() OWNER TO postgres;
ALTER FUNCTION public.fn_protect_metrologie_impact_229() OWNER TO postgres;
ALTER FUNCTION public.fn_protect_metrologie_impact_item_229() OWNER TO postgres;

COMMIT;
