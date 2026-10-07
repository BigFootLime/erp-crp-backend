DO $$ BEGIN
 IF to_regclass('public.fournisseur_domaines') IS NULL OR to_regclass('public.ged_retention_holds') IS NULL OR to_regprocedure('public.prevent_material_debit_rewrite()') IS NULL
 THEN RAISE EXCEPTION 'SUPPLIER_REVIEW_PREREQUISITES_MISSING'; END IF;
END $$;
