-- #612 preflight — read-only and deliberately fail-closed.
BEGIN TRANSACTION READ ONLY;

DO $$
BEGIN
  IF to_regclass('public.ged_document_classes') IS NULL
     OR to_regclass('public.ged_documents') IS NULL
     OR to_regclass('public.ged_document_versions') IS NULL
     OR to_regclass('public.ged_document_links') IS NULL THEN
    RAISE EXCEPTION 'AUTHORITATIVE_PDF_PREFLIGHT_GED_PREREQUISITE_MISSING';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    RAISE EXCEPTION 'AUTHORITATIVE_PDF_PREFLIGHT_APP_ROLE_MISSING';
  END IF;
  IF to_regprocedure('gen_random_uuid()') IS NULL THEN
    RAISE EXCEPTION 'AUTHORITATIVE_PDF_PREFLIGHT_UUID_GENERATOR_MISSING';
  END IF;
  IF to_regclass('public.authoritative_pdf_archives') IS NOT NULL
     OR to_regclass('public.authoritative_pdf_archive_outbox') IS NOT NULL
     OR to_regclass('public.authoritative_pdf_archive_snapshot_lookup_idx') IS NOT NULL
     OR to_regclass('public.authoritative_pdf_archive_outbox_ready_idx') IS NOT NULL
     OR to_regclass('public.authoritative_pdf_archive_outbox_stale_idx') IS NOT NULL
     OR to_regprocedure('public.fn_authoritative_pdf_archive_immutable_612()') IS NOT NULL
     OR to_regprocedure('public.fn_authoritative_pdf_archive_outbox_stamp_612()') IS NOT NULL
     OR to_regprocedure('public.fn_authoritative_pdf_archive_outbox_complete_612()') IS NOT NULL
     OR EXISTS (
       SELECT 1 FROM pg_trigger
        WHERE NOT tgisinternal
          AND tgname IN ('trg_authoritative_pdf_archive_immutable_612', 'trg_authoritative_pdf_archive_outbox_stamp_612', 'trg_authoritative_pdf_archive_outbox_complete_612')
     ) THEN
    RAISE EXCEPTION 'AUTHORITATIVE_PDF_PREFLIGHT_TARGET_ALREADY_EXISTS';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ged_document_classes WHERE class_key IN ('CERP_AUTHORITATIVE_PDF', 'CERP_SYSTEM_SNAPSHOT')) THEN
    RAISE EXCEPTION 'AUTHORITATIVE_PDF_PREFLIGHT_GED_CLASS_ALREADY_EXISTS';
  END IF;
END;
$$;

SELECT
  to_regclass('public.authoritative_pdf_archives') IS NULL AS archive_registry_absent,
  to_regclass('public.authoritative_pdf_archive_outbox') IS NULL AS archive_outbox_absent,
  NOT EXISTS (SELECT 1 FROM public.ged_document_classes WHERE class_key = 'CERP_AUTHORITATIVE_PDF') AS generated_pdf_class_absent,
  NOT EXISTS (SELECT 1 FROM public.ged_document_classes WHERE class_key = 'CERP_SYSTEM_SNAPSHOT') AS system_snapshot_class_absent,
  EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') AS app_role_present,
  to_regprocedure('gen_random_uuid()') IS NOT NULL AS uuid_generator_present;

COMMIT;
