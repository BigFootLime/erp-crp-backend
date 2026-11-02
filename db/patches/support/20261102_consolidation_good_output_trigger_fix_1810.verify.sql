\set ON_ERROR_STOP on
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.cerp_schema_migrations WHERE filename='20261102_consolidation_good_output_trigger_fix_1810.sql')
    OR position('FOREACH target IN ARRAY' IN pg_get_functiondef('public.fn_check_consolidation_quantity_712()'::regprocedure))=0 THEN
    RAISE EXCEPTION 'Consolidation trigger repair or registry entry is missing';
  END IF;
END $$;
SELECT 'Consolidation trigger repair verified (read-only)' AS result;
