-- Guarded rollback; never remove a class once evidence uses it.
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.ged_documents WHERE class_key = 'METROLOGIE_SCAN') THEN
    RAISE EXCEPTION 'METROLOGIE_SCAN contains documentary evidence; rollback refused';
  END IF;
END $$;
DELETE FROM public.ged_document_classes WHERE class_key = 'METROLOGIE_SCAN';
COMMIT;
