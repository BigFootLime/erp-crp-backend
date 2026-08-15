\set ON_ERROR_STOP on

SELECT current_database() AS database_name,
       current_user AS connected_role,
       current_setting('server_version_num')::integer AS server_version_num,
       pg_size_pretty(pg_database_size(current_database())) AS database_size,
       pg_size_pretty(pg_tablespace_size('pg_default')) AS tablespace_size;

SELECT relation, to_regclass(relation) IS NOT NULL AS present
FROM unnest(ARRAY[
  'public.users',
  'public.erp_audit_logs',
  'public.production_cost_center_rates',
  'public.programmation_calendars',
  'public.fournisseur_catalogue',
  'public.fournisseur_catalogue_prix_history',
  'public.units',
  'public.erp_settings'
]) relation;

SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') AS cerp_app_present;

SELECT
  (SELECT count(*) FROM public.production_cost_center_rates WHERE taux_horaire < 0) AS invalid_hourly_rates,
  (SELECT count(*) FROM public.programmation_calendars
    WHERE cardinality(working_days) = 0 OR day_start >= day_end) AS invalid_calendars,
  (SELECT count(*) FROM public.fournisseur_catalogue
    WHERE prix_unitaire < 0 OR delai_jours < 0 OR coef_conversion <= 0) AS invalid_supplier_values,
  (SELECT count(*) FROM public.units GROUP BY lower(code) HAVING count(*) > 1 LIMIT 1) AS duplicate_unit_code_group;

SELECT to_regclass('public.reference_data_change_sets') AS target_change_sets,
       to_regclass('public.reference_data_versions') AS target_versions,
       to_regclass('public.reference_data_decisions') AS target_decisions;
