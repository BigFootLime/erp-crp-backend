DO $$ BEGIN
 IF to_regclass('public.demand_pilot_revisions') IS NULL OR to_regclass('public.delivery_promise_roots') IS NULL THEN RAISE EXCEPTION 'firm binding prerequisites are missing'; END IF;
END $$;
