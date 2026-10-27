-- Read-only post-apply check for #1460.
DO $verify$
DECLARE table_name text;
DECLARE tables constant text[] := ARRAY[
  'metrologie_import_batches','metrologie_import_source_files',
  'metrologie_import_raw_rows','metrologie_legacy_observations'
];
BEGIN
  FOREACH table_name IN ARRAY tables LOOP
    IF to_regclass(format('public.%I', table_name)) IS NULL THEN
      RAISE EXCEPTION 'missing public.%', table_name;
    END IF;
    IF (SELECT pg_get_userbyid(c.relowner) FROM pg_class c
        WHERE c.oid = format('public.%I', table_name)::regclass) <> 'cerp_app' THEN
      RAISE EXCEPTION 'public.% is not owned by cerp_app', table_name;
    END IF;
    IF NOT has_table_privilege('cerp_app', format('public.%I', table_name), 'SELECT,INSERT,UPDATE') THEN
      RAISE EXCEPTION 'cerp_app lacks runtime access to public.%', table_name;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_protect_metrologie_import_batch_1460')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_protect_metrologie_import_raw_facts_1460')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_protect_metrologie_legacy_observations_1460') THEN
    RAISE EXCEPTION 'legacy import immutability triggers are incomplete';
  END IF;
END
$verify$;

SELECT conname
FROM pg_constraint
WHERE conrelid IN ('public.metrologie_import_batches'::regclass,
                   'public.metrologie_import_source_files'::regclass,
                   'public.metrologie_import_raw_rows'::regclass,
                   'public.metrologie_legacy_observations'::regclass)
ORDER BY conname;
