DO $$ BEGIN
 IF to_regclass('public.ged_document_versions') IS NULL
 OR to_regclass('public.authoritative_pdf_archives') IS NULL
 OR to_regprocedure('public.prevent_material_debit_rewrite()') IS NULL
 THEN RAISE EXCEPTION 'GENERAL_TERMS_PREREQUISITES_MISSING'; END IF;
END $$;
