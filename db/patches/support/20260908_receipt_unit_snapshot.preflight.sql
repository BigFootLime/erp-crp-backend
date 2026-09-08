\set ON_ERROR_STOP on
BEGIN READ ONLY;
SELECT current_database(),current_user;
SELECT 'public.reception_fournisseur_lignes'::regclass,'public.commande_fournisseur_ligne'::regclass;
SELECT unite,unite_stock,coef_conversion FROM public.commande_fournisseur_ligne LIMIT 0;
COMMIT;
