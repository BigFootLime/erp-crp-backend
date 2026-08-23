-- #625 verification: exact legal bytes must be retained immutably for GED retry.
DO $$
DECLARE n integer;
BEGIN
  IF to_regclass('public.authoritative_pdf_archives') IS NULL THEN RAISE EXCEPTION 'FINANCE_GED_ARCHIVE_VERIFY_ARCHIVE_MISSING'; END IF;
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema='public' AND table_name='authoritative_pdf_archives'
     AND column_name IN ('exact_pdf_bytes','exact_pdf_sha256','exact_pdf_size_bytes');
  IF n <> 3 THEN RAISE EXCEPTION 'FINANCE_GED_ARCHIVE_VERIFY_EXACT_COLUMNS_MISSING'; END IF;
  IF to_regprocedure('public.fn_authoritative_pdf_archive_immutable_612()') IS NULL THEN RAISE EXCEPTION 'FINANCE_GED_ARCHIVE_VERIFY_IMMUTABILITY_MISSING'; END IF;
  IF to_regprocedure('public.digest(bytea,text)') IS NULL THEN RAISE EXCEPTION 'FINANCE_GED_ARCHIVE_VERIFY_DIGEST_MISSING'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.authoritative_pdf_archives'::regclass
       AND conname = 'authoritative_pdf_archive_exact_pdf_digest_ck'
  ) THEN RAISE EXCEPTION 'FINANCE_GED_ARCHIVE_VERIFY_DIGEST_CONSTRAINT_MISSING'; END IF;
END $$;
