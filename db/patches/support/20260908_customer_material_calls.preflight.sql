\set ON_ERROR_STOP on
SELECT current_database(),current_user;
DO $$ BEGIN
  IF to_regclass('public.of_material_needs') IS NULL OR to_regclass('public.reception_fournisseur_stock_receipts') IS NULL
    THEN RAISE EXCEPTION 'Material and receipt prerequisites are missing'; END IF;
  IF to_regclass('public.of_customer_material_calls') IS NOT NULL THEN RAISE EXCEPTION 'Patch already installed; verify the migration ledger'; END IF;
END $$;
