-- Commercial portal cockpit: contracts are intentionally opt-in per portal
-- account. A contract does not carry a delivery-site key, so inferring a
-- client-wide entitlement would expose data to a site-restricted account.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE TABLE IF NOT EXISTS public.client_portal_contract_bindings (
  account_id uuid NOT NULL REFERENCES public.client_portal_accounts(id) ON DELETE RESTRICT,
  contract_id uuid NOT NULL REFERENCES public.client_contracts(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by_user_id integer REFERENCES public.users(id) ON DELETE RESTRICT,
  PRIMARY KEY(account_id, contract_id)
);

CREATE OR REPLACE FUNCTION public.fn_client_portal_contract_binding_scope_1804()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE account_client varchar; contract_client varchar;
BEGIN
  SELECT client_id INTO account_client FROM public.client_portal_accounts WHERE id=NEW.account_id;
  SELECT client_id INTO contract_client FROM public.client_contracts WHERE id=NEW.contract_id;
  IF account_client IS NULL OR contract_client IS NULL OR account_client<>contract_client THEN
    RAISE EXCEPTION 'portal contract binding tenant scope refused' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_client_portal_contract_binding_scope_1804 ON public.client_portal_contract_bindings;
CREATE TRIGGER trg_client_portal_contract_binding_scope_1804
BEFORE INSERT OR UPDATE ON public.client_portal_contract_bindings
FOR EACH ROW EXECUTE FUNCTION public.fn_client_portal_contract_binding_scope_1804();

DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='cerp_app') THEN
    GRANT SELECT,INSERT ON public.client_portal_contract_bindings TO cerp_app;
    REVOKE UPDATE,DELETE,TRUNCATE ON public.client_portal_contract_bindings FROM cerp_app;
  END IF;
END $$;
COMMIT;
