DO $$ BEGIN
 IF to_regclass('public.clients') IS NULL OR to_regclass('public.client_portal_accounts') IS NULL
    OR to_regclass('public.client_contracts') IS NULL OR to_regclass('public.client_contract_lines') IS NULL THEN
  RAISE EXCEPTION 'demand pilot prerequisites are missing';
 END IF;
END $$;
