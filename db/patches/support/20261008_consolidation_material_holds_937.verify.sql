DO $$ BEGIN
  IF to_regclass('public.production_consolidation_material_holds') IS NULL
    OR to_regclass('public.stock_reservations_active_need_lot_uq') IS NULL THEN
    RAISE EXCEPTION 'Consolidation holds or uniqueness guard missing';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.production_consolidation_material_holds'::regclass
    AND tgname='production_consolidation_material_holds_immutable' AND tgenabled='O') THEN
    RAISE EXCEPTION 'Immutable hold provenance trigger missing';
  END IF;
  IF EXISTS(SELECT 1 FROM public.production_consolidation_material_holds h
    LEFT JOIN public.stock_reservations r ON r.id=h.producer_reservation_id
    LEFT JOIN public.of_material_needs n ON n.id=h.producer_need_id
    WHERE r.id IS NULL OR n.id IS NULL OR h.transferred_qty<0 OR h.surplus_qty<0 OR h.transferred_qty+h.surplus_qty<=0) THEN
    RAISE EXCEPTION 'Invalid physical hold provenance';
  END IF;
END $$;
