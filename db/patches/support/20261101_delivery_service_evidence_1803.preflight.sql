DO $$ BEGIN
 IF to_regclass('public.delivery_promise_roots') IS NULL OR to_regclass('public.client_portal_delivery_receipts') IS NULL THEN RAISE EXCEPTION 'delivery service evidence prerequisites are missing'; END IF;
END $$;
