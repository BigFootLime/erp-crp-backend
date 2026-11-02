BEGIN;
CREATE TABLE public.demand_pilot_auto_checks(
 revision_id uuid PRIMARY KEY REFERENCES public.demand_pilot_revisions(id),
 policy_version int NOT NULL, actor_id int NOT NULL REFERENCES public.users(id),
 idempotency_key uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
 status text NOT NULL CHECK(status IN ('PROCESSING','DECIDED','REVIEW','RETRY')),
 attempts int NOT NULL DEFAULT 1 CHECK(attempts>0), next_attempt timestamptz NOT NULL, reason text
);
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='cerp_app') THEN
 GRANT SELECT,INSERT,UPDATE ON public.demand_pilot_auto_checks TO cerp_app;
END IF; END $$;
COMMIT;
