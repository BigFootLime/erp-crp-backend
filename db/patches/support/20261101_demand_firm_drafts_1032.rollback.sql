DO $$ BEGIN
 IF current_setting('cerp.migration_rehearsal',true) IS DISTINCT FROM 'on' THEN RAISE EXCEPTION 'test rehearsal only'; END IF;
 IF EXISTS(SELECT 1 FROM public.demand_pilot_firm_drafts) OR EXISTS(SELECT 1 FROM public.demand_pilot_firm_binding_scopes) THEN RAISE EXCEPTION 'firm draft evidence exists; use a forward fix'; END IF;
END $$;
DROP TABLE IF EXISTS public.demand_pilot_firm_draft_lines,public.demand_pilot_firm_binding_scopes,public.demand_pilot_firm_drafts;
