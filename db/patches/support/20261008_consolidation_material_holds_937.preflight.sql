DO $$ BEGIN
  IF to_regclass('public.production_consolidation_material_transfers') IS NULL
    OR to_regclass('public.of_material_needs') IS NULL
    OR to_regclass('public.stock_reservations_active_need_lot_uq') IS NULL THEN
    RAISE EXCEPTION 'Missing consolidation/material reservation prerequisites';
  END IF;
END $$;
