DO $$ BEGIN
 IF current_setting('cerp.migration_rehearsal',true) IS DISTINCT FROM 'on' THEN RAISE EXCEPTION 'test rehearsal only'; END IF;
 IF EXISTS(SELECT 1 FROM public.delivery_promise_site_evidence) OR EXISTS(SELECT 1 FROM public.delivery_promise_departure_events) THEN RAISE EXCEPTION 'delivery service evidence exists; use a forward fix'; END IF;
END $$;
DROP TABLE IF EXISTS public.client_portal_delivery_receipt_allocations,public.delivery_promise_departure_events,public.delivery_promise_site_evidence;
ALTER TABLE public.delivery_promise_shipments DROP COLUMN IF EXISTS departure_due_date_at_shipment;
DROP FUNCTION IF EXISTS public.guard_delivery_promise_service_evidence_1803();
