\set ON_ERROR_STOP on
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.cerp_schema_migrations WHERE filename='20261102_consolidation_good_output_trigger_fix_1810.sql') THEN
    RAISE EXCEPTION 'Consolidation trigger repair must be present before decimal repair';
  END IF;
END $$;
SELECT 'Consolidation decimal repair preflight passed (read-only)' AS result;
