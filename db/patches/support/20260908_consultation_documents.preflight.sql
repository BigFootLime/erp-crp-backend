\set ON_ERROR_STOP on
DO $$ BEGIN
  IF to_regclass('public.supplier_consultation_invitations') IS NULL OR to_regclass('public.ged_document_versions') IS NULL THEN
    RAISE EXCEPTION 'Consultation and GED migrations are prerequisites';
  END IF;
END $$;
