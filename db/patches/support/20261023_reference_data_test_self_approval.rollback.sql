-- Never rewrite/delete a decision to make rollback pass.
BEGIN;
DO $rollback$
BEGIN
  IF current_database()<>'cerp_test' THEN RETURN; END IF;
  IF EXISTS(SELECT 1 FROM public.reference_data_change_sets WHERE approved_by=proposed_by) THEN
    RAISE EXCEPTION 'Rollback refused: test self-approval evidence exists; retain the test constraint';
  END IF;
  ALTER TABLE public.reference_data_change_sets DROP CONSTRAINT reference_data_change_actor_separation_ck;
  ALTER TABLE public.reference_data_change_sets ADD CONSTRAINT reference_data_change_actor_separation_ck
    CHECK (approved_by IS NULL OR approved_by <> proposed_by);
END
$rollback$;
COMMIT;
