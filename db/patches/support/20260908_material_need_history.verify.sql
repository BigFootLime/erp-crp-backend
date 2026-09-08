\set ON_ERROR_STOP on
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_index WHERE indexrelid='public.of_material_need_current_definition_idx'::regclass AND indisunique AND indisvalid AND indpred IS NOT NULL) THEN RAISE EXCEPTION 'Current material identity protection missing'; END IF;
  IF EXISTS(SELECT 1 FROM public.of_material_needs WHERE superseded_at IS NULL GROUP BY of_id,technical_version_id,source_ref HAVING count(*)>1) THEN RAISE EXCEPTION 'Duplicate live material definition'; END IF;
END $$;
SELECT 'material need history: verified' AS result;
