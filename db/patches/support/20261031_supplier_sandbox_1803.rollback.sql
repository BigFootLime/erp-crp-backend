DO $$ BEGIN
 IF current_setting('cerp.migration_rehearsal',true) IS DISTINCT FROM 'on' THEN RAISE EXCEPTION 'test rehearsal only'; END IF;
 IF to_regclass('public.supplier_sandbox_promise_proposals') IS NOT NULL AND EXISTS(SELECT 1 FROM public.supplier_sandbox_promise_proposals) THEN RAISE EXCEPTION 'sandbox proposals exist; use a forward fix'; END IF;
END $$;
DROP TABLE IF EXISTS public.supplier_sandbox_promise_proposals,public.supplier_sandbox_accounts;
