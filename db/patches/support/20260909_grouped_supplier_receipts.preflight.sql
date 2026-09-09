\set ON_ERROR_STOP on
DO $$ BEGIN
  IF current_database()<>'cerp_test' THEN RAISE EXCEPTION 'This recipe targets cerp_test'; END IF;
  IF to_regclass('public.consumable_receipt_admissions') IS NULL THEN RAISE EXCEPTION 'Missing consommable procurement prerequisite'; END IF;
  IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='receptions_fournisseurs' AND column_name='confirmation_state') THEN RAISE EXCEPTION 'Already installed: verify instead'; END IF;
END $$;
