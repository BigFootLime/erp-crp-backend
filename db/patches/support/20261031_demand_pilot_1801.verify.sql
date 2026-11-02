DO $$ BEGIN
 IF to_regclass('public.demand_pilot_imports') IS NULL OR to_regclass('public.demand_pilot_revisions') IS NULL
    OR to_regclass('public.demand_pilot_events') IS NULL OR to_regclass('public.demand_pilot_materialization_jobs') IS NULL THEN
  RAISE EXCEPTION 'demand pilot schema verification failed';
 END IF;
END $$;
