-- Pilot settings are opt-in. Planning versions hold proposals, never executable shop orders.
BEGIN;
SET LOCAL lock_timeout='5s';
CREATE TABLE public.industrial_policies (
 client_id varchar PRIMARY KEY REFERENCES public.clients(client_id), version integer NOT NULL CHECK(version>0),
 auto_enabled boolean NOT NULL DEFAULT false, risk_limit_eur numeric(18,2) CHECK(risk_limit_eur>=0),
 updated_by integer NOT NULL REFERENCES public.users(id), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.industrial_article_rules (
 article_id uuid PRIMARY KEY REFERENCES public.articles(id), family text NOT NULL CHECK(length(btrim(family)) BETWEEN 1 AND 100),
 lead_days integer CHECK(lead_days BETWEEN 0 AND 730), unit_cost_eur numeric(18,6) CHECK(unit_cost_eur>0),
 yield_percent numeric(7,3) NOT NULL DEFAULT 100 CHECK(yield_percent>0 AND yield_percent<=100),
 lot_size numeric(18,3) CHECK(lot_size>0)
);
CREATE TABLE public.industrial_contract_rules (
 contract_line_id uuid PRIMARY KEY REFERENCES public.client_contract_lines(id),
 min_stock numeric(18,3) NOT NULL DEFAULT 0 CHECK(min_stock>=0),
 max_stock numeric(18,3) NOT NULL DEFAULT 0 CHECK(max_stock>=min_stock),
 committed_forecast boolean NOT NULL DEFAULT false, risk_limit_eur numeric(18,2) CHECK(risk_limit_eur>=0)
);
CREATE TABLE public.industrial_plan_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),client_id varchar NOT NULL REFERENCES public.clients(client_id),
 start date NOT NULL,label text NOT NULL, capacity_percent numeric(6,2) NOT NULL CHECK(capacity_percent BETWEEN 1 AND 300),
 months smallint NOT NULL DEFAULT 18 CHECK(months BETWEEN 1 AND 24),weeks smallint NOT NULL DEFAULT 26 CHECK(weeks IN (4,13,26,52)),
 status text NOT NULL DEFAULT 'QUEUED' CHECK(status IN ('QUEUED','RUNNING','READY','VALIDATED','FAILED')),
 created_by integer NOT NULL REFERENCES public.users(id), created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(), claimed uuid, source_digest text, result jsonb, error text,
 validated_by integer REFERENCES public.users(id),validated_at timestamptz
);
CREATE INDEX industrial_runs_queue ON public.industrial_plan_runs(status,created_at);
CREATE INDEX industrial_runs_client ON public.industrial_plan_runs(client_id,created_at DESC);
CREATE TABLE public.industrial_policy_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), client_id varchar NOT NULL REFERENCES public.clients(client_id),
 actor_id integer NOT NULL REFERENCES public.users(id), snapshot jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='cerp_app') THEN
 GRANT SELECT,INSERT,UPDATE ON public.industrial_policies,public.industrial_article_rules,public.industrial_contract_rules,public.industrial_plan_runs TO cerp_app;
 GRANT SELECT,INSERT ON public.industrial_policy_events TO cerp_app;
END IF; END $$;
COMMIT;
