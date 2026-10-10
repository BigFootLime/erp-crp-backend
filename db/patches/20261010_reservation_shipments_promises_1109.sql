-- Append only independently proven missing reservation-cart promise evidence.
-- Stock, shipment headers and original/revised commercial promises are immutable here.
BEGIN;
CREATE TABLE IF NOT EXISTS public.delivery_promise_shipment_reconciliations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bl_allocation_id uuid NOT NULL UNIQUE REFERENCES public.bon_livraison_ligne_allocations(id),
  root_id uuid NOT NULL REFERENCES public.delivery_promise_roots(id),
  status text NOT NULL CHECK(status IN('CAPTURED','REVIEW_REQUIRED')),
  reason text NOT NULL,
  evidence jsonb NOT NULL,
  patch_key text NOT NULL DEFAULT '20261010_reservation_shipments_promises_1109',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER guard_delivery_promise_history
  BEFORE UPDATE OR DELETE ON public.delivery_promise_shipment_reconciliations
  FOR EACH ROW EXECUTE FUNCTION public.guard_delivery_promise_history();

DO $repair$
DECLARE row record; part record; captured numeric; available numeric; reason text; proof jsonb;
BEGIN
  -- Revisions of dates/quantities cannot be reconstructed from today's parts.
  -- Only the single unchanged part that already existed at shipment is automatic.
  FOR row IN
    SELECT a.id,a.quantite,a.qty_consumed,a.stock_movement_line_id,
      r.id AS root_id,r.initial_quantity,r.created_at AS root_created,
      bl.id AS delivery_id,bl.shipped_at,bl.statut,
      (SELECT count(*) FROM public.delivery_promise_parts p WHERE p.root_id=r.id) AS part_count,
      (SELECT count(*) FROM public.bon_livraison_ship_receipts receipt
        WHERE receipt.bon_livraison_id=bl.id AND receipt.result_payload->>'statut'='SHIPPED') AS receipt_count
    FROM public.bon_livraison_ligne_allocations a
    JOIN public.bon_livraison_ligne line ON line.id=a.bon_livraison_ligne_id
    JOIN public.bon_livraison bl ON bl.id=line.bon_livraison_id
    JOIN public.delivery_promise_roots r ON r.allocation_id=a.commande_ligne_affaire_allocation_id
    WHERE bl.statut IN('SHIPPED','DELIVERED') AND a.quantite>0
      AND COALESCE((SELECT sum(s.quantity) FROM public.delivery_promise_shipments s WHERE s.bl_allocation_id=a.id),0)<>a.quantite
    ORDER BY bl.shipped_at NULLS LAST,bl.id,a.id
  LOOP
    SELECT COALESCE(sum(s.quantity),0) INTO captured FROM public.delivery_promise_shipments s WHERE s.bl_allocation_id=row.id;
    reason := NULL;
    IF captured<>0 THEN reason:='PARTIAL_CAPTURE_REQUIRES_REVIEW';
    ELSIF row.shipped_at IS NULL OR row.root_created>row.shipped_at THEN reason:='PROMISE_NOT_PROVEN_AT_SHIPMENT';
    ELSIF row.receipt_count<>1 THEN reason:='CANONICAL_SHIPMENT_RECEIPT_REQUIRED';
    ELSIF row.qty_consumed<>row.quantite OR NOT EXISTS(
      SELECT 1 FROM public.stock_movement_lines ml JOIN public.stock_movements m ON m.id=ml.movement_id
      WHERE ml.id=row.stock_movement_line_id AND m.status='POSTED' AND m.movement_type::text='OUT'
        AND ml.qty=row.quantite AND m.source_document_type='BON_LIVRAISON'
        AND m.source_document_id::text=row.delivery_id::text
    ) THEN reason:='POSTED_RESERVATION_CONSUMPTION_REQUIRED';
    ELSIF row.part_count<>1 THEN reason:='REVISED_PROMISE_REQUIRES_REVIEW';
    END IF;
    SELECT p.* INTO part FROM public.delivery_promise_parts p
      WHERE p.root_id=row.root_id AND p.revision_event_id IS NULL AND p.retired_at IS NULL
        AND p.created_at<=row.shipped_at;
    IF reason IS NULL AND (part.id IS NULL OR part.quantity<>row.initial_quantity) THEN
      reason:='UNCHANGED_INITIAL_PART_REQUIRED';
    END IF;
    IF reason IS NULL THEN
      SELECT part.quantity-COALESCE(sum(s.quantity),0) INTO available FROM public.delivery_promise_shipments s WHERE s.part_id=part.id;
      IF available<row.quantite THEN reason:='PROMISE_QUANTITY_REQUIRES_REVIEW'; END IF;
    END IF;
    proof:=jsonb_build_object('delivery_id',row.delivery_id,'shipped_at',row.shipped_at,
      'quantity',row.quantite,'previous_capture',captured,'stock_movement_line_id',row.stock_movement_line_id,
      'root_created_at',row.root_created,'part_id',part.id,'due_date',part.due_date,'receipt_count',row.receipt_count);
    IF reason IS NULL THEN
      INSERT INTO public.delivery_promise_shipments(part_id,bl_allocation_id,quantity,due_date_at_shipment)
        VALUES(part.id,row.id,row.quantite,part.due_date);
    END IF;
    INSERT INTO public.delivery_promise_shipment_reconciliations(bl_allocation_id,root_id,status,reason,evidence)
      VALUES(row.id,row.root_id,CASE WHEN reason IS NULL THEN 'CAPTURED' ELSE 'REVIEW_REQUIRED' END,
        COALESCE(reason,'PROVEN_UNCHANGED_INITIAL_PROMISE'),proof);
  END LOOP;
END $repair$;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='cerp_app') THEN
  GRANT SELECT ON public.delivery_promise_shipment_reconciliations TO cerp_app;
  REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON public.delivery_promise_shipment_reconciliations FROM cerp_app;
END IF; END $$;
COMMIT;
