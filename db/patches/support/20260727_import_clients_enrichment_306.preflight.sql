\set ON_ERROR_STOP on

DO $$
BEGIN
  IF current_database() <> 'cerp_test' THEN
    RAISE EXCEPTION 'Patch #306 refusé hors cerp_test (base actuelle : %)', current_database();
  END IF;
END
$$;

SELECT
  to_regclass('public.data_import_batches') AS import_batches_table,
  to_regclass('public.data_import_crosswalk') AS import_crosswalk_table,
  to_regclass('public.clients') AS clients_table,
  to_regclass('public.contacts') AS contacts_table;
