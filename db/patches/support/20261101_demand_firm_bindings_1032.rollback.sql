DO $$ BEGIN
 IF current_setting('cerp.migration_rehearsal',true) IS DISTINCT FROM 'on' THEN RAISE EXCEPTION 'test rehearsal only'; END IF;
 IF EXISTS(SELECT 1 FROM public.demand_pilot_firm_bindings) THEN RAISE EXCEPTION 'firm bindings exist; use a forward fix'; END IF;
END $$;
DROP TABLE IF EXISTS public.demand_pilot_firm_bindings;
