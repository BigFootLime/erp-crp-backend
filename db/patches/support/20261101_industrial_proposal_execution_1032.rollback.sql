DO $$ BEGIN
 IF current_setting('cerp.migration_rehearsal',true) IS DISTINCT FROM 'on' THEN RAISE EXCEPTION 'test rehearsal only'; END IF;
 IF EXISTS(SELECT 1 FROM public.industrial_proposal_executions) THEN RAISE EXCEPTION 'industrial execution evidence exists; use a forward fix'; END IF;
END $$;
DROP TABLE IF EXISTS public.industrial_proposal_executions;
