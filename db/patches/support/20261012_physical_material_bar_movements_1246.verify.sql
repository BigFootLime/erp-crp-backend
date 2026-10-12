\set ON_ERROR_STOP on
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.stock_material_bars'::regclass
    AND tgname='stock_material_bar_identity_1246' AND tgenabled='O' AND NOT tgisinternal
    AND tgfoid='public.protect_material_bar_identity_1246()'::regprocedure) THEN
    RAISE EXCEPTION 'The physical bar identity guard is not enabled';
  END IF;
  IF position('both posted transfer legs' IN pg_get_functiondef('public.protect_material_bar_identity_1246()'::regprocedure))=0 THEN
    RAISE EXCEPTION 'The physical bar transfer proof guard is missing';
  END IF;
  IF 4<>(SELECT count(*) FROM pg_trigger WHERE tgname IN ('stock_material_bar_stock_1246','stock_material_inventory_stock_1246',
      'stock_material_movement_stock_1246','stock_material_batch_stock_1246') AND tgenabled='O' AND tgdeferrable AND tginitdeferred
      AND tgfoid='public.check_material_bar_stock_1246()'::regprocedure) THEN
    RAISE EXCEPTION 'Physical bar commit invariants are missing or not deferred';
  END IF;
END $$;
