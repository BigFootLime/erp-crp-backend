-- Exact, immutable repayment evidence. Existing stock and receipts are unchanged.
BEGIN;
SET LOCAL lock_timeout='5s';
CREATE TABLE public.delivery_urgency_replenishments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recovery_id uuid NOT NULL REFERENCES public.delivery_urgency_recoveries(id) ON DELETE RESTRICT,
  receipt_id uuid NOT NULL REFERENCES public.of_receipts(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  reservation_id uuid NOT NULL REFERENCES public.stock_reservations(id) ON DELETE RESTRICT,
  lot_id uuid NOT NULL REFERENCES public.lots(id) ON DELETE RESTRICT,
  quantity numeric(18,3) NOT NULL CHECK(quantity>0),
  created_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX delivery_urgency_replenishments_recovery_idx ON public.delivery_urgency_replenishments(recovery_id);
CREATE INDEX delivery_urgency_replenishments_receipt_idx ON public.delivery_urgency_replenishments(receipt_id,reservation_id);
CREATE TRIGGER delivery_urgency_replenishments_immutable BEFORE UPDATE OR DELETE ON public.delivery_urgency_replenishments
  FOR EACH ROW EXECUTE FUNCTION public.fn_protect_stock_immutable_evidence();

CREATE FUNCTION public.fn_delivery_urgency_replenishment_identity_1033() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE recovery record; reservation record; restored numeric;
BEGIN
  SELECT r.*,request.status INTO recovery FROM public.delivery_urgency_recoveries r
    JOIN public.delivery_urgency_requests request ON request.id=r.request_id
    WHERE r.id=NEW.recovery_id FOR UPDATE OF r;
  SELECT * INTO reservation FROM public.stock_reservations WHERE id=NEW.reservation_id;
  SELECT COALESCE(sum(quantity),0) INTO restored FROM public.delivery_urgency_replenishments WHERE recovery_id=NEW.recovery_id;
  IF recovery.status IS DISTINCT FROM 'WITHDRAWN'
    OR reservation.commande_ligne_affaire_allocation_id IS DISTINCT FROM recovery.donor_allocation_id
    OR reservation.lot_id IS DISTINCT FROM NEW.lot_id OR reservation.status IS DISTINCT FROM 'ACTIVE'
    OR NEW.quantity>reservation.qty_reserved-reservation.qty_consumed
    OR restored+NEW.quantity>recovery.quantity THEN
    RAISE EXCEPTION 'Recovery must repay its withdrawn quantity to its own donor reservation' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER delivery_urgency_replenishment_identity BEFORE INSERT ON public.delivery_urgency_replenishments
  FOR EACH ROW EXECUTE FUNCTION public.fn_delivery_urgency_replenishment_identity_1033();

CREATE FUNCTION public.fn_delivery_urgency_replenishment_receipt_1033() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE recovery record; receipt record; routed numeric; claimed numeric; produced numeric;
BEGIN
  SELECT * INTO recovery FROM public.delivery_urgency_recoveries WHERE id=NEW.recovery_id;
  SELECT r.*,movement.status AS movement_status INTO receipt FROM public.of_receipts r
    JOIN public.stock_movements movement ON movement.id=r.stock_movement_id WHERE r.id=NEW.receipt_id;
  IF receipt.id IS NULL OR receipt.lot_id IS DISTINCT FROM NEW.lot_id OR receipt.movement_status IS DISTINCT FROM 'POSTED' THEN
    RAISE EXCEPTION 'Recovery requires a posted production receipt of the same lot' USING ERRCODE='23514';
  END IF;
  SELECT COALESCE(sum(repaid.quantity),0) INTO claimed FROM public.delivery_urgency_replenishments repaid
    WHERE repaid.receipt_id=NEW.receipt_id AND repaid.recovery_id=NEW.recovery_id;
  IF receipt.of_id=recovery.recovery_of_id THEN produced:=receipt.qty_ok;
  ELSE
    SELECT COALESCE(sum(part.quantity),0) INTO produced FROM public.production_consolidation_receipt_allocations part
      JOIN public.production_consolidation_allocations source ON source.id=part.allocation_id
      JOIN public.production_consolidations group_of ON group_of.id=source.consolidation_id
      WHERE source.source_of_id=recovery.recovery_of_id AND group_of.producer_of_id=receipt.of_id
        AND part.movement_id=receipt.stock_movement_id AND part.lot_id=NEW.lot_id;
  END IF;
  IF claimed>produced THEN
    RAISE EXCEPTION 'Recovery exceeds its own produced share of the receipt' USING ERRCODE='23514';
  END IF;
  SELECT COALESCE(sum((reservation->>'quantity')::numeric),0) INTO routed
    FROM public.production_receipt_lane_assignments assignment,
      LATERAL jsonb_array_elements(assignment.distribution->'destinations') destination,
      LATERAL jsonb_array_elements(destination->'reservations') reservation
    WHERE assignment.receipt_id=NEW.receipt_id AND destination->>'lane'='DELIVERY'
      AND COALESCE(reservation->>'source_reservation_id',reservation->>'reservation_id')=NEW.reservation_id::text;
  SELECT COALESCE(sum(quantity),0) INTO claimed FROM public.delivery_urgency_replenishments
    WHERE receipt_id=NEW.receipt_id AND reservation_id=NEW.reservation_id;
  IF claimed>routed THEN
    RAISE EXCEPTION 'Recovery requires a released receipt assigned to its donor delivery' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER delivery_urgency_replenishment_receipt AFTER INSERT ON public.delivery_urgency_replenishments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.fn_delivery_urgency_replenishment_receipt_1033();
REVOKE ALL ON public.delivery_urgency_replenishments FROM PUBLIC,cerp_app;
GRANT SELECT,INSERT ON public.delivery_urgency_replenishments TO cerp_app;
-- PostgreSQL requires a column UPDATE privilege for row locking. Identity remains immutable.
GRANT UPDATE(id) ON public.delivery_urgency_recoveries TO cerp_app;
REVOKE ALL ON FUNCTION public.fn_delivery_urgency_replenishment_identity_1033(),public.fn_delivery_urgency_replenishment_receipt_1033() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_delivery_urgency_replenishment_identity_1033(),public.fn_delivery_urgency_replenishment_receipt_1033() TO cerp_app;
COMMIT;
