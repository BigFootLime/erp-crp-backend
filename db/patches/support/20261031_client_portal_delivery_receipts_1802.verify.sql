DO $$ BEGIN
 IF to_regclass('public.client_portal_delivery_site_bindings') IS NULL OR to_regclass('public.client_portal_delivery_receipts') IS NULL OR to_regclass('public.client_portal_delivery_receipt_lines') IS NULL THEN RAISE EXCEPTION 'portal delivery receipt schema verification failed'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='trg_client_portal_delivery_receipts_immutable_1802' AND tgenabled='O') THEN RAISE EXCEPTION 'portal delivery receipt immutability trigger missing'; END IF;
END $$;
