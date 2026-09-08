\set ON_ERROR_STOP on
SELECT current_database(),current_user;
DO $$ BEGIN
  IF to_regclass('public.of_material_receipt_transfers') IS NULL THEN RAISE EXCEPTION 'Material receipt prerequisites missing'; END IF;
  IF to_regclass('public.of_material_draft_baselines') IS NOT NULL THEN RAISE EXCEPTION 'Patch already installed; verify ledger'; END IF;
END $$;
