-- Firm calls use the canonical order aggregate; historical CADRE remains explicit.
BEGIN;
SET LOCAL lock_timeout='5s';
CREATE TABLE IF NOT EXISTS public.client_contract_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL,
  client_id varchar NOT NULL,
  commande_id bigint NOT NULL UNIQUE REFERENCES public.commande_client(id) ON DELETE RESTRICT,
  contract_version integer NOT NULL CHECK(contract_version>0),
  contract_snapshot jsonb NOT NULL CHECK(jsonb_typeof(contract_snapshot)='object'),
  actor_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  customer_reference text NOT NULL,
  order_date date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(contract_id,client_id) REFERENCES public.client_contracts(id,client_id) ON DELETE RESTRICT,
  UNIQUE(actor_user_id,idempotency_key),
  UNIQUE(id,contract_id)
);
CREATE INDEX IF NOT EXISTS client_contract_calls_history_idx ON public.client_contract_calls(contract_id,created_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS public.client_contract_call_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id uuid NOT NULL,
  contract_id uuid NOT NULL,
  contract_line_id uuid NOT NULL,
  commande_ligne_id bigint NOT NULL UNIQUE REFERENCES public.commande_ligne(id) ON DELETE RESTRICT,
  article_id uuid NOT NULL REFERENCES public.articles(id) ON DELETE RESTRICT,
  piece_technique_version_id uuid NOT NULL REFERENCES public.piece_technique_versions(id) ON DELETE RESTRICT,
  unit_id uuid NOT NULL REFERENCES public.units(id) ON DELETE RESTRICT,
  initial_qty numeric(18,3) NOT NULL CHECK(initial_qty>0),
  initial_due_date date NOT NULL,
  article_snapshot jsonb NOT NULL CHECK(jsonb_typeof(article_snapshot)='object'),
  replenishment_qty numeric(18,3) NOT NULL CHECK(replenishment_qty>0),
  FOREIGN KEY(call_id,contract_id) REFERENCES public.client_contract_calls(id,contract_id) ON DELETE RESTRICT,
  FOREIGN KEY(contract_line_id,contract_id) REFERENCES public.client_contract_lines(id,contract_id) ON DELETE RESTRICT,
  UNIQUE(call_id,contract_line_id)
);
CREATE TRIGGER client_contract_calls_immutable BEFORE UPDATE OR DELETE ON public.client_contract_calls
  FOR EACH ROW EXECUTE FUNCTION public.fn_protect_stock_immutable_evidence();
CREATE TRIGGER client_contract_call_lines_immutable BEFORE UPDATE OR DELETE ON public.client_contract_call_lines
  FOR EACH ROW EXECUTE FUNCTION public.fn_protect_stock_immutable_evidence();
GRANT SELECT,INSERT ON public.client_contract_calls,public.client_contract_call_lines TO cerp_app;
REVOKE UPDATE,DELETE,TRUNCATE ON public.client_contract_calls,public.client_contract_call_lines FROM cerp_app;
COMMIT;
