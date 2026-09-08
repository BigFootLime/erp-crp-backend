\set ON_ERROR_STOP on
BEGIN READ ONLY;
SET LOCAL ROLE cerp_app;
SELECT count(lot_properties_hash),count(manual_checks_confirmed) FROM public.of_material_lot_checks;
SELECT 'public.reception_line_purchase_material_idx'::regclass;
COMMIT;
