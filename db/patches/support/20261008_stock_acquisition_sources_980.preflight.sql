BEGIN READ ONLY;
DO $$ BEGIN
  IF to_regclass('public.stock_valuation_movement_journal') IS NULL
    OR to_regprocedure('public.fn_stock_valuation_boundary_guard_977()') IS NULL
    OR to_regclass('public.reception_fournisseur_stock_receipts') IS NULL
    OR to_regclass('public.reception_stock_portions') IS NULL
    OR to_regclass('public.commande_fournisseur_ligne') IS NULL
    OR NOT EXISTS(SELECT 1 FROM public.stock_valuation_capture_boundary WHERE mode='CAPTURE_ONLY') THEN
    RAISE EXCEPTION 'Stock acquisition capture prerequisites missing';
  END IF;
  IF EXISTS(SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name IN('commande_fournisseur','commande_fournisseur_ligne',
      'reception_fournisseur_stock_receipts','reception_stock_portions','reception_fournisseur_lignes')
      AND data_type='numeric' AND numeric_scale>12) THEN
    RAISE EXCEPTION 'Stock acquisition source decimal precision unsupported';
  END IF;
END $$;
ROLLBACK;
