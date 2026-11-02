\set ON_ERROR_STOP on
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.cerp_schema_migrations WHERE filename='20261102_consolidation_good_output_trigger_decimal_fix_1811.sql')
    OR position('[.]' IN pg_get_functiondef('public.fn_check_consolidation_quantity_712()'::regprocedure))=0 THEN
    RAISE EXCEPTION 'Consolidation decimal repair or registry entry is missing';
  END IF;
END $$;
SELECT 'Consolidation decimal repair verified (read-only)' AS result;
