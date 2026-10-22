BEGIN;
CREATE TABLE IF NOT EXISTS public.financial_cutover_gate (
 singleton boolean PRIMARY KEY DEFAULT TRUE CHECK(singleton), phase text NOT NULL DEFAULT 'IDLE' CHECK(phase IN ('IDLE','PREPARING','ACTIVE')),
 started_at timestamptz, started_by integer REFERENCES public.users(id), started_batch_id uuid REFERENCES public.data_cutover_batches(id),
 activated_at timestamptz, activated_by integer REFERENCES public.users(id), activation_evidence_reference text, updated_at timestamptz NOT NULL DEFAULT now());
INSERT INTO public.financial_cutover_gate(singleton,phase) VALUES(TRUE,'IDLE') ON CONFLICT(singleton) DO NOTHING;
CREATE TABLE IF NOT EXISTS public.financial_cutover_events (id bigserial PRIMARY KEY,action text NOT NULL CHECK(action IN ('PREPARATION_STARTED','ACTIVATED')),actor_user_id integer NOT NULL REFERENCES public.users(id),batch_id uuid REFERENCES public.data_cutover_batches(id),details jsonb NOT NULL DEFAULT '{}'::jsonb,created_at timestamptz NOT NULL DEFAULT now());
CREATE OR REPLACE FUNCTION public.fn_financial_cutover_events_append_only_1710() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'financial_cutover_events is append-only'; END $$;
DROP TRIGGER IF EXISTS financial_cutover_events_append_only_1710 ON public.financial_cutover_events;
CREATE TRIGGER financial_cutover_events_append_only_1710 BEFORE UPDATE OR DELETE ON public.financial_cutover_events FOR EACH ROW EXECUTE FUNCTION public.fn_financial_cutover_events_append_only_1710();
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='cerp_app') THEN GRANT SELECT,INSERT,UPDATE ON public.financial_cutover_gate TO cerp_app; GRANT SELECT,INSERT ON public.financial_cutover_events TO cerp_app; GRANT USAGE,SELECT ON SEQUENCE public.financial_cutover_events_id_seq TO cerp_app; REVOKE DELETE,TRUNCATE ON public.financial_cutover_gate,public.financial_cutover_events FROM PUBLIC,cerp_app; REVOKE UPDATE ON public.financial_cutover_events FROM PUBLIC,cerp_app; END IF; END $$;
COMMIT;
