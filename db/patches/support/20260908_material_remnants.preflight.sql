\set ON_ERROR_STOP on
SELECT current_database(),current_user;
DO $$ BEGIN
  IF to_regclass('public.production_material_debits') IS NULL OR to_regclass('public.stock_lot_genealogy_edges') IS NULL THEN RAISE EXCEPTION 'Material debit or genealogy prerequisites missing'; END IF;
  IF to_regclass('public.production_material_remnants') IS NOT NULL THEN RAISE EXCEPTION 'Patch already installed; verify ledger'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.production_material_debits'::regclass AND conname='production_material_debits_declaration_id_fkey') THEN RAISE EXCEPTION 'Expected declaration foreign key missing'; END IF;
END $$;
