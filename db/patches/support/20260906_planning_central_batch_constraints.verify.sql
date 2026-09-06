DO $$ BEGIN
  IF (SELECT count(*) FROM pg_constraint WHERE conrelid='public.planning_events'::regclass
    AND conname IN ('planning_events_machine_no_overlap','planning_events_poste_no_overlap')
    AND condeferrable AND convalidated)<>2 THEN
    RAISE EXCEPTION 'Planning exclusion constraints not ready';
  END IF;
END $$;
