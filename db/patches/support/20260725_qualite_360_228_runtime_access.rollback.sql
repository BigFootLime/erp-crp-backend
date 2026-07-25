\set ON_ERROR_STOP on

DO $rollback$
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
  IF current_database() <> 'cerp_test' THEN
    RAISE EXCEPTION 'runtime-access rollback is restricted to cerp_test (current: %)', current_database();
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN
    RAISE EXCEPTION 'missing PostgreSQL role postgres';
  END IF;

  FOREACH table_name IN ARRAY quality_tables LOOP
    IF to_regclass(format('public.%I', table_name)) IS NULL THEN
      RAISE EXCEPTION 'missing Qualite 360 table public.%', table_name;
    END IF;

    EXECUTE format('ALTER TABLE public.%I OWNER TO postgres', table_name);
  END LOOP;
END
$rollback$;
