DO $$
BEGIN
  IF to_regclass('public.client_portal_contract_bindings') IS NULL THEN
    RAISE EXCEPTION 'Missing client_portal_contract_bindings';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.client_portal_contract_bindings'::regclass AND tgname='trg_client_portal_contract_binding_scope_1804' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'Missing client portal contract binding scope trigger';
  END IF;
END $$;
