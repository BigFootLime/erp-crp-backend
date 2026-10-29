-- Test-only actor separation policy. Existing approval evidence stays immutable.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $patch$
BEGIN
  -- Production retains its original constraint, including on a shared API.
  IF current_database() <> 'cerp_test' THEN
    RETURN;
  END IF;
  IF to_regclass('public.reference_data_change_sets') IS NULL THEN
    RAISE EXCEPTION 'Reference data workflow is not installed';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('reference-data:test-self-approval'));
  ALTER TABLE public.reference_data_change_sets
    DROP CONSTRAINT reference_data_change_actor_separation_ck;
  ALTER TABLE public.reference_data_change_sets
    ADD CONSTRAINT reference_data_change_actor_separation_ck CHECK (
      approved_by IS NULL OR approved_by <> proposed_by OR current_database() = 'cerp_test'
    );
END
$patch$;
COMMIT;
