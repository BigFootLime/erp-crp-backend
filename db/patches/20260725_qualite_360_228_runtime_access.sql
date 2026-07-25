-- 20260725_qualite_360_228_runtime_access.sql
-- Issue #132 / frontend #266
--
-- Restores the runtime ownership expected by the CERP API for the Qualite 360
-- tables introduced by Issue #228. The original patch was executed by the
-- administrative PostgreSQL role, so the new tables inherited that owner and
-- cerp_app could not read or write them.
--
-- This patch is transactional, idempotent and does not alter business data.

BEGIN;

DO $migration$
DECLARE
  table_name text;
  quality_tables constant text[] := ARRAY[
    'quality_control_plan',
    'quality_control_plan_characteristic',
    'quality_measurement_revisions',
    'quality_release_decision',
    'quality_derogation',
    'quality_derogation_consumption',
    'non_conformity_analysis',
    'quality_command_receipts'
  ];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    RAISE EXCEPTION '#132 requires the cerp_app PostgreSQL role';
  END IF;

  FOREACH table_name IN ARRAY quality_tables LOOP
    IF to_regclass(format('public.%I', table_name)) IS NULL THEN
      RAISE EXCEPTION '#132 requires public.% from the Qualite 360 #228 baseline', table_name;
    END IF;

    EXECUTE format('ALTER TABLE public.%I OWNER TO cerp_app', table_name);
  END LOOP;
END
$migration$;

COMMIT;
