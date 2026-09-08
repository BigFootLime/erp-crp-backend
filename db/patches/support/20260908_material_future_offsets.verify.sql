\set ON_ERROR_STOP on
DO $$ BEGIN
  IF to_regclass('public.of_material_draft_baselines') IS NULL OR NOT EXISTS(
    SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='commande_fournisseur_ligne_besoin' AND column_name='stock_receipt_offset'
  ) THEN RAISE EXCEPTION 'Future material offsets missing'; END IF;
END $$;
SELECT 'future receipt offsets and draft baselines: verified' AS result;
