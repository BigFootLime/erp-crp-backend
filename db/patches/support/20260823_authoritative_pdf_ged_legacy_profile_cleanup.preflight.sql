BEGIN TRANSACTION READ ONLY;

DO $preflight$
DECLARE
  marker_present boolean := to_regclass('public.cerp_authoritative_pdf_ged_bridge_20260823') IS NOT NULL;
BEGIN
  IF to_regclass('public.ged_entity_types') IS NULL
     OR to_regprocedure('public.fn_ged_link_guard()') IS NULL
     OR to_regclass('public.ged_document_links') IS NULL THEN
    RAISE EXCEPTION 'AUTHORITATIVE_PDF_GED_LEGACY_CLEANUP_PREFLIGHT_PROFILE_INVALID';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.cerp_schema_migrations
     WHERE filename = '20260823_authoritative_pdf_ged_entity_contract.sql'
  ) THEN
    RAISE EXCEPTION 'AUTHORITATIVE_PDF_GED_LEGACY_CLEANUP_PREFLIGHT_CONTRACT_NOT_RECORDED';
  END IF;
  IF marker_present THEN
    IF (SELECT COUNT(*) FROM public.cerp_authoritative_pdf_ged_bridge_20260823
         WHERE singleton AND source_profile = 'LEGACY_SOL20') <> 1
       OR (SELECT COUNT(*) FROM public.ged_entity_types) <> 17
       OR EXISTS (SELECT 1 FROM public.ged_document_links) THEN
      RAISE EXCEPTION 'AUTHORITATIVE_PDF_GED_LEGACY_CLEANUP_PREFLIGHT_BRIDGE_DRIFT';
    END IF;
  END IF;
END
$preflight$;

SELECT to_regclass('public.cerp_authoritative_pdf_ged_bridge_20260823') IS NOT NULL AS cleanup_required;

COMMIT;
