BEGIN;
CREATE TABLE IF NOT EXISTS public.supplier_internal_treatment_estimate_commands(
 actor_id integer NOT NULL REFERENCES public.users(id),idempotency_key text NOT NULL CHECK(length(idempotency_key)>=8),
 request_hash text NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(actor_id,idempotency_key)
);
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='cerp_app') THEN
 GRANT SELECT,INSERT ON public.supplier_internal_treatment_estimate_commands TO cerp_app;
END IF; END $$;
COMMIT;
