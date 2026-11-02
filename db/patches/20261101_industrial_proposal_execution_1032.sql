BEGIN;
SET LOCAL lock_timeout='5s';
CREATE TABLE public.industrial_proposal_executions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 run_id uuid NOT NULL REFERENCES public.industrial_plan_runs(id), proposal_index integer NOT NULL CHECK(proposal_index>=0),
 action text NOT NULL CHECK(action IN ('MAKE','BUY','SWITCH','REVIEW')), status text NOT NULL CHECK(status IN ('EXECUTED','REVIEW')),
 request_key text NOT NULL, request_hash text NOT NULL, source_digest text NOT NULL,
 target_type text, target_id text, reason text NOT NULL, result jsonb NOT NULL DEFAULT '{}'::jsonb,
 created_by integer NOT NULL REFERENCES public.users(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(run_id,proposal_index), UNIQUE(created_by,request_key)
);
CREATE INDEX industrial_proposal_executions_run ON public.industrial_proposal_executions(run_id,created_at DESC);
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='cerp_app') THEN
 GRANT SELECT,INSERT ON public.industrial_proposal_executions TO cerp_app;
END IF; END $$;
COMMIT;
