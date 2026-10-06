DO $$ BEGIN
  IF to_regclass('public.subcontract_purchase_origins') IS NULL OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.subcontract_purchase_origins'::regclass AND tgname='subcontract_purchase_origins_immutable' AND NOT tgisinternal)
    THEN RAISE EXCEPTION 'Subcontract purchase origin proof missing'; END IF;
END $$;
