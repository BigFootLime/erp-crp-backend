\set ON_ERROR_STOP on

DO $preflight$
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
    RAISE EXCEPTION 'runtime-access preflight is restricted to cerp_test (current: %)', current_database();
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    RAISE EXCEPTION 'missing PostgreSQL role cerp_app';
  END IF;

  FOREACH table_name IN ARRAY quality_tables LOOP
    IF to_regclass(format('public.%I', table_name)) IS NULL THEN
      RAISE EXCEPTION 'missing Qualite 360 table public.%', table_name;
    END IF;
  END LOOP;
END
$preflight$;

SELECT
  c.relname AS table_name,
  pg_get_userbyid(c.relowner) AS owner,
  has_table_privilege('cerp_app', format('public.%I', c.relname), 'SELECT') AS can_select,
  has_table_privilege('cerp_app', format('public.%I', c.relname), 'INSERT') AS can_insert,
  has_table_privilege('cerp_app', format('public.%I', c.relname), 'UPDATE') AS can_update
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname = ANY (ARRAY[
    'quality_control_plan',
    'quality_control_plan_characteristic',
    'quality_measurement_revisions',
    'quality_release_decision',
    'quality_derogation',
    'quality_derogation_consumption',
    'non_conformity_analysis',
    'quality_command_receipts'
  ])
ORDER BY c.relname;
