DO $$ BEGIN
 IF to_regclass('public.demand_pilot_revisions') IS NULL OR to_regclass('public.client_contract_lines') IS NULL THEN RAISE EXCEPTION 'materialization operation prerequisites are missing'; END IF;
END $$;
