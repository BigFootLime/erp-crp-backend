DO $$ BEGIN IF to_regclass('public.industrial_proposal_executions') IS NULL THEN RAISE EXCEPTION 'industrial execution schema verification failed'; END IF; END $$;
