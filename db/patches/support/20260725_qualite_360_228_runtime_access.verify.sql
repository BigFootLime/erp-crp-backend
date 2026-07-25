\set ON_ERROR_STOP on

DO $verify$
DECLARE
  table_name text;
  table_owner text;
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
    RAISE EXCEPTION 'runtime-access verification is restricted to cerp_test (current: %)', current_database();
  END IF;

  FOREACH table_name IN ARRAY quality_tables LOOP
    SELECT pg_get_userbyid(c.relowner)
    INTO table_owner
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = table_name
      AND c.relkind IN ('r', 'p');

    IF table_owner IS DISTINCT FROM 'cerp_app' THEN
      RAISE EXCEPTION 'public.% owner is %, expected cerp_app', table_name, COALESCE(table_owner, '<missing>');
    END IF;

    IF NOT has_table_privilege('cerp_app', format('public.%I', table_name), 'SELECT,INSERT,UPDATE') THEN
      RAISE EXCEPTION 'cerp_app lacks runtime privileges on public.%', table_name;
    END IF;
  END LOOP;
END
$verify$;

SELECT
  c.relname AS table_name,
  pg_get_userbyid(c.relowner) AS owner,
  has_table_privilege('cerp_app', format('public.%I', c.relname), 'SELECT,INSERT,UPDATE') AS runtime_access
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
