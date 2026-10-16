BEGIN TRANSACTION READ ONLY;

DO $verify$
DECLARE
  cleanup_recorded boolean := false;
  finance_profile_recorded boolean := false;
  finance_profile_complete boolean := false;
BEGIN
  IF to_regclass('public.cerp_authoritative_pdf_ged_bridge_20260823') IS NOT NULL THEN
    RAISE EXCEPTION 'AUTHORITATIVE_PDF_GED_LEGACY_CLEANUP_VERIFY_MARKER_REMAINS';
  END IF;
  IF to_regclass('public.cerp_schema_migrations') IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.cerp_schema_migrations
      WHERE filename = '20260823_authoritative_pdf_ged_legacy_profile_cleanup.sql'
    ) INTO cleanup_recorded;
    SELECT EXISTS (
      SELECT 1
      FROM public.cerp_schema_migrations
      WHERE filename = '20261014_finance_ged_profile_1268.sql'
    ) INTO finance_profile_recorded;
  END IF;
  IF cleanup_recorded
     AND finance_profile_recorded
     AND to_regclass('public.finance_ged_profile_state_1268') IS NOT NULL THEN
    SELECT COUNT(*) = 1
       AND bool_and(singleton AND registry_created)
      INTO finance_profile_complete
      FROM public.finance_ged_profile_state_1268;
  END IF;
  IF finance_profile_complete THEN
    IF to_regprocedure('public.fn_ged_link_guard()') IS NOT NULL
       OR to_regprocedure('public.fn_ged_validate_canonical_entity_link_20()') IS NULL
       OR NOT EXISTS (
         SELECT 1
         FROM pg_trigger
         WHERE tgname = 'trg_ged_validate_canonical_entity_link_20'
           AND tgrelid = 'public.ged_document_links'::regclass
           AND tgfoid = to_regprocedure('public.fn_ged_validate_canonical_entity_link_20()')
           AND tgenabled IN ('O', 'A')
           AND NOT tgisinternal
       ) THEN
      RAISE EXCEPTION 'AUTHORITATIVE_PDF_GED_LEGACY_CLEANUP_VERIFY_FINANCE_PROFILE_INVALID';
    END IF;
    RETURN;
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
          AND tgenabled IN ('O', 'A')
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
