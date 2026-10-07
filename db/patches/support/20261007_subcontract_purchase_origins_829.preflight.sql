DO $$ BEGIN
  IF to_regclass('public.commande_fournisseur_ligne') IS NULL OR to_regclass('public.of_operations') IS NULL OR to_regclass('public.lots') IS NULL
    OR to_regprocedure('public.prevent_material_debit_rewrite()') IS NULL THEN RAISE EXCEPTION 'Subcontract origin prerequisites missing'; END IF;
END $$;
