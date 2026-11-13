DO $$ BEGIN
 IF to_regclass('public.client_portal_accounts') IS NULL OR to_regclass('public.bon_livraison') IS NULL OR to_regclass('public.bon_livraison_ligne') IS NULL THEN RAISE EXCEPTION 'portal delivery receipt prerequisites are missing'; END IF;
END $$;
