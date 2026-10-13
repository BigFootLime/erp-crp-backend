BEGIN TRANSACTION READ ONLY;
DO $$
DECLARE definition text := pg_get_functiondef('public.protect_material_bar_identity_1246()'::regprocedure);
BEGIN
  IF position('NEW.public_number IS DISTINCT FROM OLD.public_number' IN definition)=0
    OR position('both posted transfer legs' IN definition)=0
    OR position('Transferred bar lengths must equal the canonical transfer quantity' IN definition)=0 THEN
    RAISE EXCEPTION 'Barcode identity and transfer proof must remain protected together';
  END IF;
  IF 2<>(SELECT count(*) FROM pg_trigger WHERE tgname IN ('stock_material_bar_identity_1246','stock_material_bar_hold_identity_1246')
    AND tgenabled='O' AND NOT tgisinternal AND tgfoid='public.protect_material_bar_identity_1246()'::regprocedure) THEN
    RAISE EXCEPTION 'Physical bar and reservation identity guards must be enabled';
  END IF;
END $$;
COMMIT;
