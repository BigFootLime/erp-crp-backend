-- Read-only preflight for #1460. It must run against a real application database,
-- never a managed template.
SELECT current_database() AS database,
       to_regclass('public.users') AS users_table,
       to_regclass('public.metrologie_equipements') AS equipment_table,
       EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') AS cerp_app_role_present,
       EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'gen_random_uuid') AS gen_random_uuid_available;

SELECT c.relname AS existing_relation, pg_get_userbyid(c.relowner) AS owner
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('metrologie_import_batches','metrologie_import_source_files',
                    'metrologie_import_raw_rows','metrologie_legacy_observations')
ORDER BY c.relname;
