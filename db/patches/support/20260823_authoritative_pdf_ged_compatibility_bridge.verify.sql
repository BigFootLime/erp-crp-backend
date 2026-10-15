BEGIN TRANSACTION READ ONLY;

DO $verify$
DECLARE
  cleanup_recorded boolean := false;
  finance_profile_recorded boolean := false;
  finance_profile_complete boolean := false;
BEGIN
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

  -- The Finance profile deliberately recreates the closed registry after the
  -- legacy bridge cleanup. Its private state row and ledger entry are required
  -- so a recreated registry alone can never impersonate that terminal profile.
  IF cleanup_recorded
     AND finance_profile_recorded
     AND to_regclass('public.finance_ged_profile_state_1268') IS NOT NULL THEN
    SELECT COUNT(*) = 1
       AND bool_and(singleton AND registry_created)
      INTO finance_profile_complete
      FROM public.finance_ged_profile_state_1268;
  END IF;

  IF cleanup_recorded AND (to_regclass('public.ged_entity_types') IS NULL OR finance_profile_complete) THEN
    IF to_regclass('public.cerp_authoritative_pdf_ged_bridge_20260823') IS NOT NULL
       OR to_regprocedure('public.fn_ged_link_guard()') IS NOT NULL
       OR to_regclass('public.ged_document_links') IS NULL
       OR to_regprocedure('public.fn_ged_validate_canonical_entity_link_20()') IS NULL
       OR NOT EXISTS (
         SELECT 1 FROM pg_trigger
          WHERE tgname = 'trg_ged_validate_canonical_entity_link_20'
            AND tgrelid = to_regclass('public.ged_document_links')
            AND tgfoid = to_regprocedure('public.fn_ged_validate_canonical_entity_link_20()')
            AND tgenabled IN ('O', 'A')
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
