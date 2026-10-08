DO $$ BEGIN
  IF to_regclass('public.devis') IS NULL OR to_regclass('public.devis_ligne') IS NULL
    OR to_regclass('public.margin_input_versions') IS NULL OR to_regclass('public.margin_rate_versions') IS NULL THEN
    RAISE EXCEPTION 'Quote margin capture prerequisites missing';
  END IF;
END $$;
