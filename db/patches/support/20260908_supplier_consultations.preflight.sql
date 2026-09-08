\set ON_ERROR_STOP on
BEGIN READ ONLY;
SELECT current_database(),current_user;
SELECT 'public.commande_fournisseur'::regclass,'public.commande_fournisseur_ligne'::regclass,'public.fournisseurs'::regclass,'public.users'::regclass;
SELECT fournisseur_snapshot,conditions_snapshot,updated_at FROM public.commande_fournisseur LIMIT 0;
SELECT exigences_qualite,documents_attendus,unite,unite_stock,coef_conversion FROM public.commande_fournisseur_ligne LIMIT 0;
COMMIT;
