\set ON_ERROR_STOP on
DO $guard$
BEGIN
  IF current_database() <> 'cerp_test' OR current_setting('cerp.migration_rehearsal', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION '#617 rollback is test-only: cerp_test and cerp.migration_rehearsal=on required';
  END IF;
END $guard$;
BEGIN;
DROP TRIGGER IF EXISTS trg_guard_of_execution_release_617 ON public.ordres_fabrication;
DROP FUNCTION IF EXISTS public.fn_guard_of_execution_release_617();
DROP TABLE IF EXISTS public.of_release_decisions;
DROP FUNCTION IF EXISTS public.fn_of_release_decisions_append_only_617();
COMMIT;
