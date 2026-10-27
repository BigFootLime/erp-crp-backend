-- TEST ONLY: never run where an import batch exists.
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.metrologie_import_batches) THEN
    RAISE EXCEPTION 'refusing rollback: legacy import evidence exists';
  END IF;
END $$;
DROP TABLE IF EXISTS public.metrologie_legacy_observations;
DROP TABLE IF EXISTS public.metrologie_import_raw_rows;
DROP TABLE IF EXISTS public.metrologie_import_source_files;
DROP TABLE IF EXISTS public.metrologie_import_batches;
DROP FUNCTION IF EXISTS public.fn_protect_metrologie_import_batch_1460();
DROP FUNCTION IF EXISTS public.fn_protect_metrologie_legacy_import_1460();
COMMIT;
