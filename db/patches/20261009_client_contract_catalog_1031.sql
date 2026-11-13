-- Client-owned contract definitions; existing orders, OFs and BLs stay unchanged.
BEGIN;
SET LOCAL lock_timeout='5s';
CREATE TABLE IF NOT EXISTS public.client_contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id varchar NOT NULL REFERENCES public.clients(client_id) ON DELETE RESTRICT,
  reference text NOT NULL CHECK(length(btrim(reference)) BETWEEN 1 AND 100),
  title text NOT NULL CHECK(length(btrim(title)) BETWEEN 1 AND 200),
  valid_from date,
  valid_until date,
  status text NOT NULL DEFAULT 'DRAFT' CHECK(status IN('DRAFT','ACTIVE','CLOSED')),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  created_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  updated_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(valid_from IS NULL OR valid_until IS NULL OR valid_until>=valid_from),
  UNIQUE(id,client_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS client_contract_reference_idx ON public.client_contracts(client_id,lower(btrim(reference)));
CREATE INDEX IF NOT EXISTS client_contract_client_idx ON public.client_contracts(client_id,status,reference,id);
CREATE TABLE IF NOT EXISTS public.client_contract_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL REFERENCES public.client_contracts(id) ON DELETE RESTRICT,
  article_id uuid NOT NULL REFERENCES public.articles(id) ON DELETE RESTRICT,
  root_article_id uuid NOT NULL REFERENCES public.articles(id) ON DELETE RESTRICT,
  replenishment_qty numeric(18,3) NOT NULL CHECK(replenishment_qty>0),
  unit_id uuid NOT NULL REFERENCES public.units(id) ON DELETE RESTRICT,
  configured_code text NOT NULL,
  configured_designation text NOT NULL,
  configured_indice text NOT NULL,
  configured_piece_technique_version_id uuid NOT NULL REFERENCES public.piece_technique_versions(id) ON DELETE RESTRICT,
  active boolean NOT NULL DEFAULT true,
  UNIQUE(contract_id,root_article_id),
  UNIQUE(id,contract_id)
);
CREATE TABLE IF NOT EXISTS public.client_contract_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL REFERENCES public.client_contracts(id) ON DELETE RESTRICT,
  client_id varchar NOT NULL,
  actor_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  action text NOT NULL CHECK(action IN('CREATE','UPDATE','CLOSE')),
  previous_snapshot jsonb,
  result_payload jsonb NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(contract_id,client_id) REFERENCES public.client_contracts(id,client_id) ON DELETE RESTRICT,
  UNIQUE(actor_user_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS client_contract_events_history_idx ON public.client_contract_events(contract_id,created_at DESC,id DESC);
DROP TRIGGER IF EXISTS client_contract_events_immutable ON public.client_contract_events;
CREATE TRIGGER client_contract_events_immutable BEFORE UPDATE OR DELETE ON public.client_contract_events
  FOR EACH ROW EXECUTE FUNCTION public.fn_protect_stock_immutable_evidence();
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='cerp_app') THEN
  GRANT SELECT,INSERT,UPDATE ON public.client_contracts,public.client_contract_lines TO cerp_app;
  GRANT SELECT,INSERT ON public.client_contract_events TO cerp_app;
  REVOKE DELETE,TRUNCATE ON public.client_contracts,public.client_contract_lines FROM cerp_app;
  REVOKE UPDATE,DELETE,TRUNCATE ON public.client_contract_events FROM cerp_app;
 END IF;
END $$;
COMMIT;
