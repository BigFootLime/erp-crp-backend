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
END $$;
