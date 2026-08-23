-- #625 preflight — read-only, fail closed and safe to run before deployment.
BEGIN TRANSACTION READ ONLY;

DO $$
BEGIN
  IF to_regclass('public.authoritative_pdf_archives') IS NULL
     OR to_regclass('public.authoritative_pdf_archive_outbox') IS NULL
     OR to_regprocedure('public.fn_authoritative_pdf_archive_immutable_612()') IS NULL THEN
    RAISE EXCEPTION 'FINANCE_GED_ARCHIVE_PREFLIGHT_612_PREREQUISITE_MISSING';
  END IF;
  IF to_regprocedure('public.digest(bytea,text)') IS NULL THEN
    RAISE EXCEPTION 'FINANCE_GED_ARCHIVE_PREFLIGHT_DIGEST_PREREQUISITE_MISSING';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='authoritative_pdf_archives'
       AND column_name IN ('exact_pdf_bytes','exact_pdf_sha256','exact_pdf_size_bytes')
  ) THEN
    RAISE EXCEPTION 'FINANCE_GED_ARCHIVE_PREFLIGHT_TARGET_ALREADY_EXISTS';
  END IF;
END $$;

SELECT
  to_regclass('public.authoritative_pdf_archives') IS NOT NULL AS archive_registry_present,
  to_regprocedure('public.digest(bytea,text)') IS NOT NULL AS bytea_digest_present;

COMMIT;
