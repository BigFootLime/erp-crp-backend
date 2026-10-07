-- Forecast placement belongs to the calculation, not to committed planning events.
BEGIN;
ALTER TABLE public.planning_tasks ADD COLUMN IF NOT EXISTS forecast_resource_ids text[];
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.planning_tasks'::regclass
    AND conname='planning_tasks_forecast_resources_check') THEN
    ALTER TABLE public.planning_tasks ADD CONSTRAINT planning_tasks_forecast_resources_check CHECK (
      forecast_resource_ids IS NULL OR (forecast_start IS NOT NULL AND forecast_end IS NOT NULL
        AND array_position(forecast_resource_ids, NULL) IS NULL));
  END IF;
END $$;
-- No guessed placement for old dates. Recalculate from canonical constraints.
INSERT INTO public.planning_recalculation_jobs(entity_table,entity_id,source_revision)
  SELECT 'planning_forecast_resources','931',revision FROM public.planning_central_settings WHERE singleton
  AND NOT EXISTS (SELECT 1 FROM public.planning_recalculation_jobs
    WHERE entity_table='planning_forecast_resources' AND entity_id='931');
COMMIT;
