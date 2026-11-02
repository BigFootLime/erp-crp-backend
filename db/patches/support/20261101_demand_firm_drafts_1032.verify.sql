DO $$ BEGIN
 IF to_regclass('public.demand_pilot_firm_drafts') IS NULL OR to_regclass('public.demand_pilot_firm_draft_lines') IS NULL OR to_regclass('public.demand_pilot_firm_binding_scopes') IS NULL THEN RAISE EXCEPTION 'firm draft schema verification failed'; END IF;
END $$;
