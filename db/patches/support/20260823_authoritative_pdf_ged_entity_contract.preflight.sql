-- Authoritative PDF/GED entity contract preflight — read-only and fail-closed.
BEGIN TRANSACTION READ ONLY;

DO $guard$
BEGIN
  IF to_regclass('public.ged_entity_types') IS NULL
     OR to_regclass('public.ged_document_links') IS NULL
     OR to_regprocedure('public.fn_ged_link_guard()') IS NULL THEN
    RAISE EXCEPTION 'AUTHORITATIVE_PDF_GED_ENTITY_CONTRACT_PREFLIGHT_PREREQUISITE_MISSING';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'trg_ged_link_guard'
       AND tgrelid = 'public.ged_document_links'::regclass
       AND tgfoid = to_regprocedure('public.fn_ged_link_guard()')
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'AUTHORITATIVE_PDF_GED_ENTITY_CONTRACT_PREFLIGHT_LINK_GUARD_MISSING';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.ged_entity_types
     WHERE entity_type IN ('BON_LIVRAISON', 'DEVIS', 'COMMANDE_FOURNISSEUR', 'FACTURE', 'AVOIR')
  ) THEN
    RAISE EXCEPTION 'AUTHORITATIVE_PDF_GED_ENTITY_CONTRACT_PREFLIGHT_TARGET_ALREADY_EXISTS';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.ged_document_links
     WHERE entity_type IN ('BON_LIVRAISON', 'DEVIS', 'COMMANDE_FOURNISSEUR', 'FACTURE', 'AVOIR')
  ) THEN
    RAISE EXCEPTION 'AUTHORITATIVE_PDF_GED_ENTITY_CONTRACT_PREFLIGHT_UNREGISTERED_LINK_EXISTS';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'bon_livraison' AND column_name = 'id'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'devis' AND column_name = 'id'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'commande_fournisseur' AND column_name = 'id'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'facture' AND column_name = 'id'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'avoir' AND column_name = 'id'
  ) THEN
    RAISE EXCEPTION 'AUTHORITATIVE_PDF_GED_ENTITY_CONTRACT_PREFLIGHT_PARENT_TABLE_MISSING';
  END IF;
END
$guard$;

SELECT
  to_regclass('public.ged_entity_types') IS NOT NULL AS entity_registry_present,
  to_regprocedure('public.fn_ged_link_guard()') IS NOT NULL AS link_guard_present,
  NOT EXISTS (
    SELECT 1 FROM public.ged_entity_types
     WHERE entity_type IN ('BON_LIVRAISON', 'DEVIS', 'COMMANDE_FOURNISSEUR', 'FACTURE', 'AVOIR')
  ) AS target_types_absent;

COMMIT;
