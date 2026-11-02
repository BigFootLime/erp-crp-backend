DO $$ BEGIN
 IF current_setting('cerp.e2e_isolated',true)='on' AND (to_regclass('public.supplier_sandbox_accounts') IS NULL OR to_regclass('public.supplier_sandbox_promise_proposals') IS NULL) THEN RAISE EXCEPTION 'supplier sandbox schema verification failed'; END IF;
END $$;
