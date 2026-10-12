-- Additive provenance when a recovery joins a producer with existing material holds.
BEGIN;
SET LOCAL lock_timeout='5s';
CREATE TABLE public.production_recovery_material_extensions (
  consolidation_id uuid NOT NULL,
  reservation_id uuid NOT NULL,
  recovery_id uuid NOT NULL REFERENCES public.delivery_urgency_recoveries(id) ON DELETE RESTRICT,
  producer_reservation_id uuid NOT NULL,
  quantity numeric(12,3) NOT NULL CHECK(quantity>0),
  included_in_base boolean NOT NULL,
  producer_reserved_before numeric(12,3) NOT NULL CHECK(producer_reserved_before>=0),
  producer_consumed_before numeric(12,3) NOT NULL CHECK(producer_consumed_before>=0 AND producer_consumed_before<=producer_reserved_before),
  producer_prepared_before numeric(12,3) NOT NULL CHECK(producer_prepared_before>=0),
  created_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(consolidation_id,reservation_id),
  FOREIGN KEY(consolidation_id,reservation_id) REFERENCES public.production_consolidation_material_transfers(consolidation_id,reservation_id) ON DELETE RESTRICT,
  FOREIGN KEY(consolidation_id,producer_reservation_id) REFERENCES public.production_consolidation_material_holds(consolidation_id,producer_reservation_id) ON DELETE RESTRICT,
  CHECK(NOT included_in_base OR (producer_reserved_before=0 AND producer_consumed_before=0 AND producer_prepared_before=0))
);
CREATE INDEX production_recovery_material_extensions_hold_idx ON public.production_recovery_material_extensions(consolidation_id,producer_reservation_id);
CREATE INDEX production_recovery_material_extensions_recovery_idx ON public.production_recovery_material_extensions(recovery_id);
CREATE TRIGGER production_recovery_material_extensions_immutable BEFORE UPDATE OR DELETE
  ON public.production_recovery_material_extensions FOR EACH ROW EXECUTE FUNCTION public.prevent_material_debit_rewrite();

CREATE FUNCTION public.fn_recovery_material_extension_1034() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source record; target record; transfer record; hold record; recovery record; grouping record; extra numeric;
BEGIN
  SELECT g.* INTO grouping FROM public.production_consolidations g WHERE g.id=NEW.consolidation_id FOR UPDATE;
  SELECT r.*,request.status AS request_status INTO recovery FROM public.delivery_urgency_recoveries r
    JOIN public.delivery_urgency_requests request ON request.id=r.request_id WHERE r.id=NEW.recovery_id;
  SELECT * INTO source FROM public.stock_reservations WHERE id=NEW.reservation_id;
  SELECT * INTO target FROM public.stock_reservations WHERE id=NEW.producer_reservation_id;
  SELECT * INTO transfer FROM public.production_consolidation_material_transfers
    WHERE consolidation_id=NEW.consolidation_id AND reservation_id=NEW.reservation_id;
  SELECT * INTO hold FROM public.production_consolidation_material_holds
    WHERE consolidation_id=NEW.consolidation_id AND producer_reservation_id=NEW.producer_reservation_id;
  IF grouping.state IS DISTINCT FROM 'ACTIVE' OR recovery.request_status IS NULL OR recovery.request_status NOT IN ('WAITING_PLANNER','APPROVED')
    OR source.of_id IS DISTINCT FROM recovery.recovery_of_id OR target.of_id IS DISTINCT FROM grouping.producer_of_id
    OR source.of_id IS NOT DISTINCT FROM target.of_id
    OR source.source_type IS DISTINCT FROM 'OF' OR source.source_id IS DISTINCT FROM source.of_id::text
    OR target.source_type IS DISTINCT FROM 'OF' OR target.source_id IS DISTINCT FROM target.of_id::text
    OR source.status IS DISTINCT FROM 'RELEASED' OR target.status IS DISTINCT FROM 'ACTIVE'
    OR source.qty_consumed IS DISTINCT FROM 0 OR source.qty_prepared IS DISTINCT FROM 0
    OR source.qty_reserved IS DISTINCT FROM NEW.quantity
    OR source.article_id IS DISTINCT FROM target.article_id OR source.location_id IS DISTINCT FROM target.location_id
    OR source.lot_id IS NULL OR source.lot_id IS DISTINCT FROM target.lot_id
    OR source.stock_batch_id IS NULL OR source.stock_batch_id IS DISTINCT FROM target.stock_batch_id
    OR transfer.source_of_id IS DISTINCT FROM source.of_id OR transfer.source_need_id IS DISTINCT FROM source.material_need_id
    OR transfer.producer_need_id IS DISTINCT FROM target.material_need_id OR hold.producer_need_id IS DISTINCT FROM target.material_need_id
    OR transfer.producer_reservation_id IS DISTINCT FROM target.id OR transfer.source_reserved_qty IS DISTINCT FROM NEW.quantity
    OR target.qty_reserved IS DISTINCT FROM NEW.producer_reserved_before+NEW.quantity
    OR target.qty_consumed IS DISTINCT FROM NEW.producer_consumed_before OR target.qty_prepared IS DISTINCT FROM NEW.producer_prepared_before
    OR (source.expires_at IS NOT NULL AND source.expires_at<=now()) OR (target.expires_at IS NOT NULL AND target.expires_at<=now())
    OR (source.expires_at IS NOT NULL AND (target.expires_at IS NULL OR target.expires_at>source.expires_at)) THEN
    RAISE EXCEPTION 'Recovery material transfer changed its identity, quantity or consumption history' USING ERRCODE='23514';
  END IF;
  SELECT COALESCE(sum(quantity),0) INTO extra FROM public.production_recovery_material_extensions
    WHERE consolidation_id=NEW.consolidation_id AND producer_reservation_id=NEW.producer_reservation_id AND NOT included_in_base;
  IF NEW.included_in_base THEN
    IF hold.transferred_qty IS DISTINCT FROM NEW.quantity OR hold.surplus_qty IS DISTINCT FROM 0
      OR EXISTS(SELECT 1 FROM public.production_recovery_material_extensions WHERE consolidation_id=NEW.consolidation_id AND producer_reservation_id=NEW.producer_reservation_id) THEN
      RAISE EXCEPTION 'New recovery hold must contain only its original transfer' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.producer_reserved_before IS DISTINCT FROM hold.transferred_qty+hold.surplus_qty+extra THEN
    RAISE EXCEPTION 'Existing producer hold does not match its immutable evidence' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER recovery_material_extension_identity BEFORE INSERT ON public.production_recovery_material_extensions
  FOR EACH ROW EXECUTE FUNCTION public.fn_recovery_material_extension_1034();

CREATE FUNCTION public.fn_recovery_material_extension_allocation_1034() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected numeric; actual numeric; surplus numeric; target record; source record;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.production_consolidation_allocations a
    JOIN public.delivery_urgency_recoveries r ON r.recovery_of_id=a.source_of_id
    WHERE a.consolidation_id=NEW.consolidation_id AND r.id=NEW.recovery_id AND a.state='ACTIVE' AND a.quantity=r.quantity) THEN
    RAISE EXCEPTION 'Transferred recovery material requires its exact active production allocation' USING ERRCODE='23514';
  END IF;
  SELECT h.transferred_qty+COALESCE((SELECT sum(e.quantity) FROM public.production_recovery_material_extensions e
    WHERE e.consolidation_id=h.consolidation_id AND e.producer_reservation_id=h.producer_reservation_id AND NOT e.included_in_base),0)
    ,h.surplus_qty INTO expected,surplus FROM public.production_consolidation_material_holds h
    WHERE h.consolidation_id=NEW.consolidation_id AND h.producer_reservation_id=NEW.producer_reservation_id;
  SELECT COALESCE(sum(source_reserved_qty),0) INTO actual FROM public.production_consolidation_material_transfers
    WHERE consolidation_id=NEW.consolidation_id AND producer_reservation_id=NEW.producer_reservation_id;
  IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'Producer hold must retain every source transfer exactly once' USING ERRCODE='23514';
  END IF;
  SELECT * INTO target FROM public.stock_reservations WHERE id=NEW.producer_reservation_id;
  SELECT * INTO source FROM public.stock_reservations WHERE id=NEW.reservation_id;
  IF target.qty_reserved IS DISTINCT FROM expected+surplus OR target.status IS DISTINCT FROM 'ACTIVE'
    OR target.qty_consumed IS DISTINCT FROM NEW.producer_consumed_before OR target.qty_prepared IS DISTINCT FROM NEW.producer_prepared_before
    OR source.status IS DISTINCT FROM 'RELEASED' OR source.qty_reserved IS DISTINCT FROM NEW.quantity
    OR source.qty_consumed IS DISTINCT FROM 0 OR source.qty_prepared IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'Recovery transfer must preserve both reservations through transaction commit' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER recovery_material_extension_allocation AFTER INSERT ON public.production_recovery_material_extensions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.fn_recovery_material_extension_allocation_1034();
REVOKE ALL ON public.production_recovery_material_extensions FROM PUBLIC,cerp_app;
GRANT SELECT,INSERT ON public.production_recovery_material_extensions TO cerp_app;
REVOKE ALL ON FUNCTION public.fn_recovery_material_extension_1034(),public.fn_recovery_material_extension_allocation_1034() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_recovery_material_extension_1034(),public.fn_recovery_material_extension_allocation_1034() TO cerp_app;
COMMIT;
