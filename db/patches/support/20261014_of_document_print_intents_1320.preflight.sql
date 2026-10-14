DO $$ BEGIN
  IF to_regclass('public.of_documents') IS NULL OR to_regclass('public.ged_documents') IS NULL
    OR to_regclass('public.ged_document_versions') IS NULL THEN
    RAISE EXCEPTION 'OF printing requires OF documents and GED';
  END IF;
END $$;
