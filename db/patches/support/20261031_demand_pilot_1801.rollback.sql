DO $$ BEGIN
 IF current_setting('cerp.migration_rehearsal',true) IS DISTINCT FROM 'on' THEN RAISE EXCEPTION 'test rehearsal only'; END IF;
 IF EXISTS(SELECT 1 FROM public.demand_pilot_imports) OR EXISTS(SELECT 1 FROM public.demand_pilot_revisions) OR EXISTS(SELECT 1 FROM public.demand_pilot_events) THEN RAISE EXCEPTION 'demand evidence exists; use a forward fix'; END IF;
END $$;
DROP TABLE IF EXISTS public.demand_pilot_forecast_bindings,public.demand_pilot_materialization_jobs,public.demand_pilot_events,public.demand_pilot_revisions,public.client_portal_demand_sites,public.demand_pilot_imports;
