BEGIN TRANSACTION READ ONLY;

DO $verify$
BEGIN
  IF to_regclass('public.cerp_authoritative_pdf_ged_bridge_20260823') IS NOT NULL THEN
    RAISE EXCEPTION 'AUTHORITATIVE_PDF_GED_LEGACY_CLEANUP_VERIFY_MARKER_REMAINS';
  END IF;
  IF to_regclass('public.ged_entity_types') IS NOT NULL THEN
    IF to_regprocedure('public.fn_ged_link_guard()') IS NULL
       OR (SELECT COUNT(*) FROM public.ged_entity_types
            WHERE entity_type IN ('BON_LIVRAISON', 'DEVIS', 'COMMANDE_FOURNISSEUR', 'FACTURE', 'AVOIR')) <> 5 THEN
      RAISE EXCEPTION 'AUTHORITATIVE_PDF_GED_LEGACY_CLEANUP_VERIFY_CLOSED_PROFILE_INVALID';
    END IF;
    RETURN;
  END IF;
  IF to_regprocedure('public.fn_ged_link_guard()') IS NOT NULL
     OR to_regprocedure('public.fn_ged_validate_canonical_entity_link_20()') IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM pg_trigger
        WHERE tgname = 'trg_ged_validate_canonical_entity_link_20'
          AND tgrelid = 'public.ged_document_links'::regclass
          AND tgfoid = to_regprocedure('public.fn_ged_validate_canonical_entity_link_20()')
          AND NOT tgisinternal
     ) THEN
    RAISE EXCEPTION 'AUTHORITATIVE_PDF_GED_LEGACY_CLEANUP_VERIFY_LEGACY_PROFILE_INVALID';
  END IF;
END
$verify$;

SELECT CASE
  WHEN to_regclass('public.ged_entity_types') IS NOT NULL THEN 'CLOSED_REGISTRY'
  ELSE 'LEGACY_SOL20'
END AS restored_ged_profile;

COMMIT;
