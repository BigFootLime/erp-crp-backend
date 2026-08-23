BEGIN TRANSACTION READ ONLY;

DO $preflight$
BEGIN
  IF to_regclass('public.ged_document_links') IS NULL THEN
    RAISE EXCEPTION 'AUTHORITATIVE_PDF_GED_COMPATIBILITY_PREFLIGHT_LINK_TABLE_MISSING';
  END IF;
  IF to_regclass('public.cerp_authoritative_pdf_ged_bridge_20260823') IS NOT NULL THEN
    RAISE EXCEPTION 'AUTHORITATIVE_PDF_GED_COMPATIBILITY_PREFLIGHT_MARKER_ALREADY_EXISTS';
  END IF;
  IF to_regclass('public.ged_entity_types') IS NOT NULL THEN
    IF to_regprocedure('public.fn_ged_link_guard()') IS NULL
       OR NOT EXISTS (
         SELECT 1 FROM pg_trigger
          WHERE tgname = 'trg_ged_link_guard'
            AND tgrelid = 'public.ged_document_links'::regclass
            AND tgfoid = to_regprocedure('public.fn_ged_link_guard()')
            AND NOT tgisinternal
       ) THEN
      RAISE EXCEPTION 'AUTHORITATIVE_PDF_GED_COMPATIBILITY_PREFLIGHT_CLOSED_PROFILE_INVALID';
    END IF;
    RETURN;
  END IF;
  IF to_regprocedure('public.fn_ged_validate_canonical_entity_link_20()') IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM pg_trigger
        WHERE tgname = 'trg_ged_validate_canonical_entity_link_20'
          AND tgrelid = 'public.ged_document_links'::regclass
          AND tgfoid = to_regprocedure('public.fn_ged_validate_canonical_entity_link_20()')
          AND NOT tgisinternal
     ) THEN
    RAISE EXCEPTION 'AUTHORITATIVE_PDF_GED_COMPATIBILITY_PREFLIGHT_LEGACY_PROFILE_INVALID';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ged_document_links) THEN
    RAISE EXCEPTION 'AUTHORITATIVE_PDF_GED_COMPATIBILITY_PREFLIGHT_LEGACY_LINKS_NOT_EMPTY';
  END IF;
END
$preflight$;

SELECT CASE
  WHEN to_regclass('public.ged_entity_types') IS NOT NULL THEN 'CLOSED_REGISTRY'
  ELSE 'LEGACY_SOL20'
END AS ged_profile;

COMMIT;
