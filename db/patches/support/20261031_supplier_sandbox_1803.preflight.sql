DO $$ BEGIN
 IF current_setting('cerp.e2e_isolated',true) IS DISTINCT FROM 'on' THEN RAISE EXCEPTION 'supplier sandbox patch is isolated-test only'; END IF;
 IF to_regclass('public.fournisseurs') IS NULL OR to_regclass('public.commande_fournisseur') IS NULL OR to_regclass('public.commande_fournisseur_ligne') IS NULL THEN RAISE EXCEPTION 'supplier sandbox prerequisites are missing'; END IF;
END $$;
