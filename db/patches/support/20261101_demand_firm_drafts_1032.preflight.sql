DO $$ BEGIN
 IF to_regclass('public.demand_pilot_firm_bindings') IS NULL OR to_regclass('public.commande_client') IS NULL OR to_regclass('public.commande_ligne') IS NULL THEN RAISE EXCEPTION 'firm draft prerequisites are missing'; END IF;
END $$;
