DO $$ BEGIN
  IF to_regclass('public.supplier_internal_treatment_estimate_commands') IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid='public.supplier_internal_treatment_estimate_commands'::regclass AND contype='p'
  ) THEN RAISE EXCEPTION 'Missing treatment command idempotency ledger'; END IF;
END $$;
