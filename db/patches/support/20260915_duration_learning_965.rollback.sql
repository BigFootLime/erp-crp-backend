-- Functional rollback, deliberately additive: retain measurements, audit and queues.
-- Run only on the approved target. Re-enable LEARN after diagnosis and verification.
BEGIN;
UPDATE public.planning_central_settings
SET activation='EXECUTE',revision=revision+1,updated_at=clock_timestamp()
WHERE singleton AND activation='LEARN';
INSERT INTO public.planning_recalculation_jobs(entity_table,entity_id,source_revision)
SELECT 'planning_estimation_observations','learning-disabled',revision FROM public.planning_central_settings WHERE singleton;
COMMIT;
