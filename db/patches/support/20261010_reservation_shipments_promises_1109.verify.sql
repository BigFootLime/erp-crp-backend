DO $$ BEGIN
  IF to_regclass('public.delivery_promise_shipment_reconciliations') IS NULL OR NOT EXISTS(
    SELECT 1 FROM pg_trigger WHERE tgrelid='public.delivery_promise_shipment_reconciliations'::regclass
      AND tgname='guard_delivery_promise_history' AND tgenabled='O'
  ) THEN RAISE EXCEPTION 'Immutable reconciliation journal missing'; END IF;
  IF EXISTS(SELECT 1 FROM public.delivery_promise_shipment_reconciliations r
    JOIN public.bon_livraison_ligne_allocations a ON a.id=r.bl_allocation_id
    WHERE r.status='CAPTURED' AND COALESCE((SELECT sum(s.quantity) FROM public.delivery_promise_shipments s WHERE s.bl_allocation_id=a.id),0)<>a.quantite)
    THEN RAISE EXCEPTION 'Reconciliation quantity mismatch'; END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='cerp_app') AND (
    NOT has_table_privilege('cerp_app','public.delivery_promise_shipment_reconciliations','SELECT')
    OR has_table_privilege('cerp_app','public.delivery_promise_shipment_reconciliations','INSERT,UPDATE,DELETE,TRUNCATE')
  ) THEN RAISE EXCEPTION 'Reconciliation privileges mismatch'; END IF;
END $$;
SELECT status,count(*) FROM public.delivery_promise_shipment_reconciliations GROUP BY status;
