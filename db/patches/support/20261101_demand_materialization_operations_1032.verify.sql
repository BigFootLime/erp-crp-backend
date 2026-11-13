DO $$ BEGIN IF to_regclass('public.demand_pilot_materialization_operations') IS NULL THEN RAISE EXCEPTION 'materialization operations schema verification failed'; END IF; END $$;
