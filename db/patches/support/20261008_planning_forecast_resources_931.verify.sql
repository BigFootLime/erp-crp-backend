DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
    AND table_name='planning_tasks' AND column_name='forecast_resource_ids' AND udt_name='_text') THEN
    RAISE EXCEPTION 'Forecast placement column missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.planning_tasks'::regclass
    AND conname='planning_tasks_forecast_resources_check' AND convalidated) THEN
    RAISE EXCEPTION 'Forecast placement consistency guard missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.planning_recalculation_jobs
    WHERE entity_table='planning_forecast_resources' AND entity_id='931') THEN
    RAISE EXCEPTION 'Initial recalculation missing';
  END IF;
END $$;
