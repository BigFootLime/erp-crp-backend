DO $$ BEGIN
  IF to_regclass('public.users') IS NULL OR to_regclass('public.supplier_internal_treatment_estimates') IS NULL THEN
    RAISE EXCEPTION 'Internal treatment estimate prerequisites are missing';
  END IF;
END $$;
