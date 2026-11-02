DO $$ BEGIN IF to_regclass('public.demand_pilot_firm_bindings') IS NULL THEN RAISE EXCEPTION 'firm bindings schema verification failed'; END IF; END $$;
