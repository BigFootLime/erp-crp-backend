DO $$ BEGIN
 IF to_regclass('public.commande_fournisseur') IS NULL OR to_regclass('public.commercial_general_terms_selections') IS NULL OR to_regclass('public.ged_retention_holds') IS NULL OR to_regprocedure('public.prevent_material_debit_rewrite()') IS NULL
 THEN RAISE EXCEPTION 'Supplier contract prerequisites are missing'; END IF;
END $$;
SELECT to_regclass('public.commande_fournisseur') IS NOT NULL AS orders_present,
 to_regclass('public.commercial_general_terms_selections') IS NOT NULL AS terms_present,
 to_regclass('public.ged_retention_holds') IS NOT NULL AS holds_present,
 to_regprocedure('public.prevent_material_debit_rewrite()') IS NOT NULL AS immutable_guard_present;
SELECT column_name,data_type,numeric_precision,numeric_scale FROM information_schema.columns
 WHERE table_schema='public' AND table_name='commande_fournisseur_ligne' AND column_name IN ('quantite','prix_unitaire_ht','qty_annulee','unite','coef_conversion');
