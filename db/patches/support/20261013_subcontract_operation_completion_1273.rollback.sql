-- Run only together with a source rollback, and only if no evidence was written.
-- Once used, retain additive schema during rollback to preserve execution history.
BEGIN;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM public.subcontract_operation_completions) THEN
    RAISE EXCEPTION 'SUBCONTRACT_COMPLETION_ROLLBACK_REQUIRES_RETAINING_EVIDENCE';
  END IF;
END $$;
DROP VIEW IF EXISTS public.production_operation_quantities;
DROP TRIGGER IF EXISTS external_local_output_1273 ON public.production_quantity_declarations;
DROP FUNCTION IF EXISTS public.guard_external_local_output_1273();
DROP TABLE IF EXISTS public.subcontract_operation_completions;
DROP FUNCTION IF EXISTS public.guard_subcontract_completion_1273();
COMMIT;
