\set ON_ERROR_STOP on
BEGIN READ ONLY;
SELECT current_database(),current_user;
SELECT 'public.of_material_lot_checks'::regclass,'public.reception_fournisseur_lignes'::regclass;
SELECT column_name,data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='of_material_lot_checks' ORDER BY ordinal_position;
COMMIT;
