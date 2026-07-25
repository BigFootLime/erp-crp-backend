-- Verify #229 runtime ownership and least-privilege grants.
-- Read-only; safe on cerp_test and cerp_prod.

BEGIN READ ONLY;

DO $verify$
DECLARE
  table_name text;
  function_name text;
  actual_owner text;
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
    SELECT tableowner
      INTO actual_owner
      FROM pg_tables
     WHERE schemaname = 'public'
       AND tablename = table_name;

    IF actual_owner IS DISTINCT FROM 'postgres' THEN
      RAISE EXCEPTION 'public.% owner is %, expected postgres', table_name, actual_owner;
    END IF;

    IF NOT has_table_privilege('cerp_app', format('public.%I', table_name), 'SELECT')
       OR NOT has_table_privilege('cerp_app', format('public.%I', table_name), 'INSERT')
       OR NOT has_table_privilege('cerp_app', format('public.%I', table_name), 'UPDATE')
       OR has_table_privilege('cerp_app', format('public.%I', table_name), 'DELETE')
       OR has_table_privilege('cerp_app', format('public.%I', table_name), 'TRUNCATE') THEN
      RAISE EXCEPTION 'public.% mutable-table grants are not least privilege', table_name;
    END IF;
  END LOOP;

  FOREACH table_name IN ARRAY ARRAY[
    'metrologie_event_log',
    'metrologie_measurement_revision',
    'metrologie_command_receipts'
  ]
  LOOP
    SELECT tableowner
      INTO actual_owner
      FROM pg_tables
     WHERE schemaname = 'public'
       AND tablename = table_name;

    IF actual_owner IS DISTINCT FROM 'postgres' THEN
      RAISE EXCEPTION 'public.% owner is %, expected postgres', table_name, actual_owner;
    END IF;

    IF NOT has_table_privilege('cerp_app', format('public.%I', table_name), 'SELECT')
       OR NOT has_table_privilege('cerp_app', format('public.%I', table_name), 'INSERT')
       OR has_table_privilege('cerp_app', format('public.%I', table_name), 'UPDATE')
       OR has_table_privilege('cerp_app', format('public.%I', table_name), 'DELETE')
       OR has_table_privilege('cerp_app', format('public.%I', table_name), 'TRUNCATE') THEN
      RAISE EXCEPTION 'public.% append-only grants are not least privilege', table_name;
    END IF;
  END LOOP;

  FOREACH function_name IN ARRAY ARRAY[
    'fn_protect_metrologie_equipement_229',
    'fn_protect_metrologie_plan_version_229',
    'fn_protect_metrologie_execution_229',
    'fn_protect_metrologie_measurement_229',
    'fn_protect_metrologie_certificat_229',
    'fn_metrologie_append_only_229',
    'fn_protect_metrologie_categorie_229',
    'fn_protect_metrologie_impact_229',
    'fn_protect_metrologie_impact_item_229'
  ]
  LOOP
    SELECT pg_get_userbyid(proowner)
      INTO actual_owner
      FROM pg_proc
     WHERE pronamespace = 'public'::regnamespace
       AND proname = function_name
       AND pronargs = 0;

    IF actual_owner IS DISTINCT FROM 'postgres' THEN
      RAISE EXCEPTION 'public.%() owner is %, expected postgres', function_name, actual_owner;
    END IF;
  END LOOP;
END
$verify$;

SELECT
  current_database() AS database_name,
  'metrologie_360_229_runtime_grants_ok' AS verification;

ROLLBACK;
