BEGIN TRANSACTION READ ONLY;

DO $verify$
DECLARE
  cleanup_recorded boolean := false;
BEGIN
  IF to_regclass('public.cerp_schema_migrations') IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.cerp_schema_migrations
      WHERE filename = '20260823_authoritative_pdf_ged_legacy_profile_cleanup.sql'
    ) INTO cleanup_recorded;
  END IF;

  -- The bridge is transitional. Once the immutable cleanup is recorded, the
  -- legacy SOL-20 profile is valid only with the canonical guard restored and
  -- every temporary bridge object removed. Closed-registry databases continue
  -- through the original verification below because cleanup is a no-op there.
  IF cleanup_recorded AND to_regclass('public.ged_entity_types') IS NULL THEN
    IF to_regclass('public.cerp_authoritative_pdf_ged_bridge_20260823') IS NOT NULL
       OR to_regprocedure('public.fn_ged_link_guard()') IS NOT NULL
       OR to_regclass('public.ged_document_links') IS NULL
       OR to_regprocedure('public.fn_ged_validate_canonical_entity_link_20()') IS NULL
       OR NOT EXISTS (
         SELECT 1 FROM pg_trigger
          WHERE tgname = 'trg_ged_validate_canonical_entity_link_20'
            AND tgrelid = to_regclass('public.ged_document_links')
            AND tgfoid = to_regprocedure('public.fn_ged_validate_canonical_entity_link_20()')
            AND NOT tgisinternal
       ) THEN
      RAISE EXCEPTION 'AUTHORITATIVE_PDF_GED_COMPATIBILITY_VERIFY_CLEANUP_DRIFT';
    END IF;
    RETURN;
  END IF;

  IF to_regclass('public.ged_entity_types') IS NULL
     OR to_regprocedure('public.fn_ged_link_guard()') IS NULL
     OR to_regclass('public.ged_document_links') IS NULL THEN
    RAISE EXCEPTION 'AUTHORITATIVE_PDF_GED_COMPATIBILITY_VERIFY_BRIDGE_MISSING';
  END IF;
  IF to_regclass('public.cerp_authoritative_pdf_ged_bridge_20260823') IS NOT NULL THEN
    IF (SELECT COUNT(*) FROM public.cerp_authoritative_pdf_ged_bridge_20260823
         WHERE singleton AND source_profile = 'LEGACY_SOL20') <> 1
       OR (SELECT COUNT(*) FROM public.ged_entity_types) <> 12 THEN
      RAISE EXCEPTION 'AUTHORITATIVE_PDF_GED_COMPATIBILITY_VERIFY_BRIDGE_DRIFT';
    END IF;
  END IF;
END
$verify$;

SELECT
  to_regclass('public.cerp_authoritative_pdf_ged_bridge_20260823') IS NOT NULL AS temporary_legacy_bridge,
  to_regprocedure('public.fn_ged_link_guard()') IS NOT NULL AS closed_guard_present,
  to_regprocedure('public.fn_ged_validate_canonical_entity_link_20()') IS NOT NULL AS canonical_guard_present;

COMMIT;
