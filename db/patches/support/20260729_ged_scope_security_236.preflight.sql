\set ON_ERROR_STOP on

DO $preflight$
BEGIN
  IF to_regclass('public.ged_document_classes') IS NULL THEN
    RAISE EXCEPTION '#236: public.ged_document_classes absente - appliquer 20260727_ged_core.sql';
  END IF;

  IF to_regclass('public.ged_documents') IS NULL
     OR to_regclass('public.ged_document_links') IS NULL
     OR to_regclass('public.ged_document_versions') IS NULL
     OR to_regclass('public.ged_access_events') IS NULL THEN
    RAISE EXCEPTION '#236: noyau GED incomplet';
  END IF;

  IF to_regclass('public.piece_technique_versions') IS NULL THEN
    RAISE EXCEPTION '#236: parent PIECE_TECHNIQUE_VERSION indisponible';
  END IF;
END
$preflight$;

SELECT 'GED_SCOPE_SECURITY_236_PREFLIGHT_OK' AS result;
