-- Demand pilot: imported customer demand is evidence first. It never creates an
-- order, an acknowledgement, an OF or a stock reservation by itself.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE TABLE IF NOT EXISTS public.demand_pilot_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id varchar NOT NULL REFERENCES public.clients(client_id) ON DELETE RESTRICT,
  external_site text NOT NULL CHECK(length(btrim(external_site)) BETWEEN 1 AND 80),
  source_version text NOT NULL CHECK(length(btrim(source_version)) BETWEEN 1 AND 160),
  source_as_of timestamptz NOT NULL,
  request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  submitted_by_user_id integer REFERENCES public.users(id) ON DELETE RESTRICT,
  submitted_by_portal_account_id uuid REFERENCES public.client_portal_accounts(id) ON DELETE RESTRICT,
  source_file_name text,
  snapshot_complete boolean NOT NULL DEFAULT false,
  row_count integer NOT NULL CHECK(row_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(num_nonnulls(submitted_by_user_id, submitted_by_portal_account_id) = 1),
  UNIQUE(client_id, external_site, source_version, request_hash)
);
CREATE TABLE IF NOT EXISTS public.client_portal_demand_sites (
  portal_account_id uuid NOT NULL REFERENCES public.client_portal_accounts(id) ON DELETE RESTRICT,
  external_site text NOT NULL CHECK(length(btrim(external_site)) BETWEEN 1 AND 80),
  created_at timestamptz NOT NULL DEFAULT now(), created_by_user_id integer REFERENCES public.users(id) ON DELETE RESTRICT,
  PRIMARY KEY(portal_account_id, external_site)
);
-- Keeps a rerun against a database created by an earlier draft additive.
ALTER TABLE public.demand_pilot_imports ADD COLUMN IF NOT EXISTS snapshot_complete boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS public.demand_pilot_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id uuid NOT NULL REFERENCES public.demand_pilot_imports(id) ON DELETE RESTRICT,
  client_id varchar NOT NULL REFERENCES public.clients(client_id) ON DELETE RESTRICT,
  external_site text NOT NULL,
  external_order_key text NOT NULL,
  external_line_key text NOT NULL,
  external_schedule_key text NOT NULL,
  source_version text NOT NULL,
  source_as_of timestamptz NOT NULL,
  kind text NOT NULL CHECK(kind IN ('FIRM','FORECAST')),
  quantity numeric(18,3) NOT NULL CHECK(quantity > 0),
  unit text NOT NULL CHECK(length(btrim(unit)) BETWEEN 1 AND 32),
  quantity_basis text NOT NULL DEFAULT 'TOTAL' CHECK(quantity_basis IN ('TOTAL','REMAINING')),
  need_date date NOT NULL,
  article_code text,
  article_id uuid REFERENCES public.articles(id) ON DELETE RESTRICT,
  contract_id uuid REFERENCES public.client_contracts(id) ON DELETE RESTRICT,
  contract_line_id uuid,
  customer_reference text,
  comment text,
  revision_no integer NOT NULL CHECK(revision_no > 0),
  diff_type text NOT NULL CHECK(diff_type IN ('NEW','CHANGED','UNCHANGED','REMOVED')),
  status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','REVIEW','ACCEPTED','REJECTED','ACCEPTED_PENDING_MATERIALIZATION','MATERIALIZED')),
  before_snapshot jsonb,
  after_snapshot jsonb NOT NULL,
  supersedes_id uuid REFERENCES public.demand_pilot_revisions(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  decided_by_user_id integer REFERENCES public.users(id) ON DELETE RESTRICT,
  decision_reason text,
  scenario_code text,
  planner_evidence jsonb,
  materialization_ref text,
  UNIQUE(client_id, external_site, external_order_key, external_line_key, external_schedule_key, revision_no),
  FOREIGN KEY(contract_line_id, contract_id) REFERENCES public.client_contract_lines(id, contract_id) ON DELETE RESTRICT
);
-- Backward compatible with a pilot schema created before quantity semantics were
-- made explicit. Existing source rows are conservatively considered totals.
ALTER TABLE public.demand_pilot_revisions ADD COLUMN IF NOT EXISTS unit text;
ALTER TABLE public.demand_pilot_revisions ADD COLUMN IF NOT EXISTS quantity_basis text NOT NULL DEFAULT 'TOTAL';
UPDATE public.demand_pilot_revisions SET unit='UNSPECIFIED' WHERE unit IS NULL;
ALTER TABLE public.demand_pilot_revisions ALTER COLUMN unit SET NOT NULL;
ALTER TABLE public.demand_pilot_revisions DROP CONSTRAINT IF EXISTS demand_pilot_revisions_quantity_basis_check;
ALTER TABLE public.demand_pilot_revisions ADD CONSTRAINT demand_pilot_revisions_quantity_basis_check CHECK(quantity_basis IN ('TOTAL','REMAINING'));
CREATE INDEX IF NOT EXISTS demand_pilot_revisions_current_idx ON public.demand_pilot_revisions(client_id, external_site, external_order_key, external_line_key, external_schedule_key, revision_no DESC);
CREATE INDEX IF NOT EXISTS demand_pilot_revisions_status_idx ON public.demand_pilot_revisions(client_id, status, need_date, id);

-- The decision transaction records work durably before any ERP command is
-- attempted. A retry always uses this row and never invents a second call/AR.
CREATE TABLE IF NOT EXISTS public.demand_pilot_materialization_jobs (
  revision_id uuid PRIMARY KEY REFERENCES public.demand_pilot_revisions(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','PROCESSING','DONE','FAILED','REVIEW')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
  idempotency_key uuid NOT NULL UNIQUE,
  requested_by_user_id integer REFERENCES public.users(id) ON DELETE RESTRICT,
  last_error text,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS demand_pilot_materialization_jobs_pending_idx ON public.demand_pilot_materialization_jobs(status,created_at);
CREATE TABLE IF NOT EXISTS public.demand_pilot_forecast_bindings (
  forecast_id uuid PRIMARY KEY REFERENCES public.client_contract_forecasts(id) ON DELETE RESTRICT,
  contract_line_id uuid NOT NULL REFERENCES public.client_contract_lines(id) ON DELETE RESTRICT,
  month date NOT NULL CHECK(extract(day FROM month)=1),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(contract_line_id,month)
);

CREATE TABLE IF NOT EXISTS public.demand_pilot_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  revision_id uuid NOT NULL REFERENCES public.demand_pilot_revisions(id) ON DELETE RESTRICT,
  import_id uuid REFERENCES public.demand_pilot_imports(id) ON DELETE RESTRICT,
  actor_user_id integer REFERENCES public.users(id) ON DELETE RESTRICT,
  actor_portal_account_id uuid REFERENCES public.client_portal_accounts(id) ON DELETE RESTRICT,
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  action text NOT NULL CHECK(action IN ('IMPORT','DECISION','PORTAL_RESPONSE')),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(num_nonnulls(actor_user_id, actor_portal_account_id) = 1),
  UNIQUE(actor_user_id, idempotency_key),
  UNIQUE(actor_portal_account_id, idempotency_key)
);
-- A regular unique constraint permits multiple NULLs.  This expression index
-- makes an idempotency key unique for either kind of authenticated actor.
CREATE UNIQUE INDEX IF NOT EXISTS demand_pilot_events_actor_idempotency_uidx
  ON public.demand_pilot_events ((COALESCE('u:' || actor_user_id::text, 'p:' || actor_portal_account_id::text)), idempotency_key);

CREATE OR REPLACE FUNCTION public.fn_demand_pilot_event_immutable_1801() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Demand pilot event evidence is immutable'; END $$;
CREATE TRIGGER demand_pilot_events_immutable BEFORE UPDATE OR DELETE ON public.demand_pilot_events
  FOR EACH ROW EXECUTE FUNCTION public.fn_demand_pilot_event_immutable_1801();
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='cerp_app') THEN
  GRANT SELECT,INSERT,UPDATE ON public.demand_pilot_imports,public.demand_pilot_revisions TO cerp_app;
  GRANT SELECT,INSERT,UPDATE ON public.demand_pilot_materialization_jobs TO cerp_app;
  GRANT SELECT,INSERT ON public.demand_pilot_forecast_bindings TO cerp_app;
  GRANT SELECT ON public.client_portal_demand_sites TO cerp_app;
  GRANT SELECT,INSERT ON public.demand_pilot_events TO cerp_app;
  REVOKE DELETE,TRUNCATE ON public.demand_pilot_imports,public.demand_pilot_revisions,public.demand_pilot_events FROM cerp_app;
  REVOKE UPDATE,DELETE,TRUNCATE ON public.demand_pilot_events FROM cerp_app;
 END IF;
END $$;
COMMIT;
