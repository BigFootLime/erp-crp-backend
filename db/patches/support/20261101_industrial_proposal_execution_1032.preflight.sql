DO $$ BEGIN IF to_regclass('public.industrial_plan_runs') IS NULL THEN RAISE EXCEPTION 'industrial execution prerequisites are missing'; END IF; END $$;
