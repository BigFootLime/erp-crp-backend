\set ON_ERROR_STOP on
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.cerp_schema_migrations WHERE filename='20261102_consolidation_good_output_invariants_1809.sql')
    OR NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.production_consolidations'::regclass AND attname='quantity_semantics' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'Good-output invariant migration must be present before trigger repair';
  END IF;
END $$;
SELECT 'Consolidation trigger repair preflight passed (read-only)' AS result;
