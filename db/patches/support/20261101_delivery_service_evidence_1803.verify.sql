DO $$ BEGIN
 IF to_regclass('public.delivery_promise_site_evidence') IS NULL OR to_regclass('public.delivery_promise_departure_events') IS NULL OR to_regclass('public.client_portal_delivery_receipt_allocations') IS NULL THEN RAISE EXCEPTION 'delivery service evidence schema verification failed'; END IF;
END $$;
