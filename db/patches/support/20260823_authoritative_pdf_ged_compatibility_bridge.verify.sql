BEGIN TRANSACTION READ ONLY;

DO $verify$
BEGIN
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
  to_regprocedure('public.fn_ged_link_guard()') IS NOT NULL AS closed_guard_present;

COMMIT;
