-- Guarded rollback for an empty, unapplied SOL-18 feature only.
-- If any evidence exists, restore the validated pre-migration backup into a new
-- database and promote it; never erase industrial evidence in place.
BEGIN;
DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM public.procurement_promised_date_events)
     OR EXISTS (SELECT 1 FROM public.procurement_anomaly_actions)
     OR EXISTS (SELECT 1 FROM public.procurement_policy_versions)
     OR EXISTS (SELECT 1 FROM public.procurement_command_receipts) THEN
    RAISE EXCEPTION 'SOL-18 rollback refused: procurement evidence exists; restore the pre-migration backup into a fresh database';
  END IF;
END
$guard$;

DROP TABLE public.procurement_command_receipts;
DROP TABLE public.procurement_policy_versions;
DROP TABLE public.procurement_anomaly_actions;
DROP TABLE public.procurement_promised_date_events;
DROP FUNCTION public.fn_procurement_evidence_append_only();
DELETE FROM public.cerp_schema_migrations WHERE filename = '20260812_procurement_reliability_sol18.sql';
COMMIT;
