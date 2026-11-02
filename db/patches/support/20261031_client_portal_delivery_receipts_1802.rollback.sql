DO $$ BEGIN
 IF current_setting('cerp.migration_rehearsal',true) IS DISTINCT FROM 'on' THEN RAISE EXCEPTION 'test rehearsal only'; END IF;
 IF EXISTS(SELECT 1 FROM public.client_portal_delivery_receipts) THEN RAISE EXCEPTION 'delivery receipt evidence exists; use a forward fix'; END IF;
END $$;
DROP TABLE IF EXISTS public.client_portal_delivery_receipt_lines,public.client_portal_delivery_receipts,public.client_portal_delivery_site_bindings;
DROP FUNCTION IF EXISTS public.fn_client_portal_delivery_receipt_guard_1802(),public.fn_client_portal_delivery_evidence_immutable_1802();
