\set ON_ERROR_STOP on
BEGIN READ ONLY;
DO $$ BEGIN
 IF to_regclass('public.of_material_needs') IS NULL OR to_regclass('public.of_material_lot_checks') IS NULL OR to_regclass('public.of_material_receipt_transfers') IS NULL THEN RAISE EXCEPTION 'Material tables missing'; END IF;
 IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='stock_reservations' AND column_name='material_need_id') THEN RAISE EXCEPTION 'Reservation adapter missing'; END IF;
 IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='commande_fournisseur_ligne_besoin' AND column_name='material_need_id') THEN RAISE EXCEPTION 'Purchase adapter missing'; END IF;
END $$;
SET LOCAL ROLE cerp_app;
SELECT count(*) AS material_needs FROM public.of_material_needs;
SELECT count(*) AS lot_checks FROM public.of_material_lot_checks;
SELECT count(*) AS receipt_transfers FROM public.of_material_receipt_transfers;
COMMIT;
