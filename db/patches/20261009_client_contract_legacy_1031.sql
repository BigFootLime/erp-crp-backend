-- Explicit historical association. No order, BL, OF, AR or stock is rewritten.
BEGIN;
SET LOCAL lock_timeout='5s';
CREATE TABLE public.client_contract_legacy_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL,
  client_id varchar NOT NULL,
  commande_id bigint NOT NULL UNIQUE REFERENCES public.commande_client(id) ON DELETE RESTRICT,
  contract_version integer NOT NULL CHECK(contract_version>0),
  contract_snapshot jsonb NOT NULL CHECK(jsonb_typeof(contract_snapshot)='object'),
  source_snapshot jsonb NOT NULL CHECK(jsonb_typeof(source_snapshot)='object'),
  source_hash text NOT NULL CHECK(source_hash ~ '^[a-f0-9]{64}$'),
  actor_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 3 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(contract_id,client_id) REFERENCES public.client_contracts(id,client_id) ON DELETE RESTRICT,
  UNIQUE(actor_user_id,idempotency_key),
  UNIQUE(id,contract_id)
);
CREATE INDEX client_contract_legacy_orders_history_idx ON public.client_contract_legacy_orders(contract_id,created_at DESC,id);
CREATE TABLE public.client_contract_legacy_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_order_id uuid NOT NULL,
  contract_id uuid NOT NULL,
  contract_line_id uuid NOT NULL,
  commande_ligne_id bigint NOT NULL UNIQUE REFERENCES public.commande_ligne(id) ON DELETE RESTRICT,
  article_id uuid NOT NULL REFERENCES public.articles(id) ON DELETE RESTRICT,
  root_article_id uuid NOT NULL REFERENCES public.articles(id) ON DELETE RESTRICT,
  piece_technique_version_id uuid REFERENCES public.piece_technique_versions(id) ON DELETE RESTRICT,
  unit_id uuid NOT NULL REFERENCES public.units(id) ON DELETE RESTRICT,
  historical_line jsonb NOT NULL CHECK(jsonb_typeof(historical_line)='object'),
  FOREIGN KEY(legacy_order_id,contract_id) REFERENCES public.client_contract_legacy_orders(id,contract_id) ON DELETE RESTRICT,
  FOREIGN KEY(contract_line_id,contract_id) REFERENCES public.client_contract_lines(id,contract_id) ON DELETE RESTRICT
);
CREATE TRIGGER client_contract_legacy_orders_immutable BEFORE UPDATE OR DELETE ON public.client_contract_legacy_orders
  FOR EACH ROW EXECUTE FUNCTION public.fn_protect_stock_immutable_evidence();
CREATE TRIGGER client_contract_legacy_lines_immutable BEFORE UPDATE OR DELETE ON public.client_contract_legacy_lines
  FOR EACH ROW EXECUTE FUNCTION public.fn_protect_stock_immutable_evidence();
GRANT SELECT,INSERT ON public.client_contract_legacy_orders,public.client_contract_legacy_lines TO cerp_app;
REVOKE UPDATE,DELETE,TRUNCATE ON public.client_contract_legacy_orders,public.client_contract_legacy_lines FROM cerp_app;

CREATE FUNCTION public.guard_legacy_contract_order_identity() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,public AS $$ BEGIN
  IF EXISTS(SELECT 1 FROM public.client_contract_legacy_orders WHERE commande_id=OLD.id) THEN
    IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Associated historical order is retained'; END IF;
    IF NEW.client_id IS DISTINCT FROM OLD.client_id OR NEW.order_type IS DISTINCT FROM OLD.order_type THEN
      RAISE EXCEPTION 'Associated historical order identity is immutable';
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER legacy_contract_order_identity BEFORE UPDATE OR DELETE ON public.commande_client
  FOR EACH ROW EXECUTE FUNCTION public.guard_legacy_contract_order_identity();

CREATE FUNCTION public.guard_legacy_contract_line_identity() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,public AS $$ BEGIN
  IF TG_OP='INSERT' THEN
    IF EXISTS(SELECT 1 FROM public.client_contract_legacy_orders WHERE commande_id=NEW.commande_id) THEN
      RAISE EXCEPTION 'Create future demand as a firm contract call, not a new historical line';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='UPDATE' AND NEW.commande_id IS DISTINCT FROM OLD.commande_id
    AND EXISTS(SELECT 1 FROM public.client_contract_legacy_orders WHERE commande_id=NEW.commande_id) THEN
    RAISE EXCEPTION 'Cannot move a new line into an associated historical order';
  END IF;
  IF EXISTS(SELECT 1 FROM public.client_contract_legacy_lines WHERE commande_ligne_id=OLD.id) THEN
    IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Associated historical line is retained'; END IF;
    IF NEW.commande_id IS DISTINCT FROM OLD.commande_id OR NEW.article_id IS DISTINCT FROM OLD.article_id
      OR NEW.piece_technique_id IS DISTINCT FROM OLD.piece_technique_id
      OR NEW.piece_technique_version_id IS DISTINCT FROM OLD.piece_technique_version_id
      OR lower(NEW.unite) IS DISTINCT FROM lower(OLD.unite) THEN
      RAISE EXCEPTION 'Associated historical line identity is immutable';
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
-- AFTER waits for the canonical FK/row locks before checking a just-committed
-- association. It also prevents an INSERT that began before the reprise from
-- adding an unmapped historical line after the parent lock is released.
CREATE TRIGGER legacy_contract_line_identity AFTER INSERT OR UPDATE OR DELETE ON public.commande_ligne
  FOR EACH ROW EXECUTE FUNCTION public.guard_legacy_contract_line_identity();
COMMIT;
