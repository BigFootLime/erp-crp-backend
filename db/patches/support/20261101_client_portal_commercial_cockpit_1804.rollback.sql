BEGIN;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM public.client_portal_contract_bindings) THEN
    RAISE EXCEPTION 'Client portal contract bindings exist; retain the schema and revoke access instead.';
  END IF;
END $$;
DROP TABLE IF EXISTS public.client_portal_contract_bindings;
DROP FUNCTION IF EXISTS public.fn_client_portal_contract_binding_scope_1804();
COMMIT;
