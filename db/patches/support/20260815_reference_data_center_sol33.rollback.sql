\set ON_ERROR_STOP on

BEGIN;

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM public.reference_data_versions)
     OR EXISTS (SELECT 1 FROM public.reference_data_change_sets)
     OR EXISTS (SELECT 1 FROM public.reference_data_decisions) THEN
    RAISE EXCEPTION 'SOL-33 rollback refused: governance evidence exists; restore the pre-migration backup instead';
  END IF;
END
$guard$;

DROP TRIGGER IF EXISTS reference_data_decisions_append_only ON public.reference_data_decisions;
DROP TRIGGER IF EXISTS reference_data_versions_guard ON public.reference_data_versions;
DROP FUNCTION IF EXISTS public.fn_reference_data_decision_append_only();
DROP FUNCTION IF EXISTS public.fn_reference_data_version_guard();
DROP TABLE IF EXISTS public.reference_data_decisions;
DROP TABLE IF EXISTS public.reference_data_versions;
DROP TABLE IF EXISTS public.reference_data_change_sets;

COMMIT;
