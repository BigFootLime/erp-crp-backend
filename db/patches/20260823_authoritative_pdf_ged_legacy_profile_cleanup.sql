-- Remove only the compatibility bridge created for the legacy production GED
-- profile.  Closed-registry databases are deliberately left unchanged.

BEGIN;

DO $cleanup$
DECLARE
  marker_present boolean := to_regclass('public.cerp_authoritative_pdf_ged_bridge_20260823') IS NOT NULL;
  contract_recorded boolean := false;
BEGIN
  IF to_regclass('public.cerp_schema_migrations') IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.cerp_schema_migrations
       WHERE filename = '20260823_authoritative_pdf_ged_entity_contract.sql'
    ) INTO contract_recorded;
  END IF;

  IF NOT marker_present THEN
    IF to_regclass('public.ged_entity_types') IS NULL
       OR to_regprocedure('public.fn_ged_link_guard()') IS NULL
       OR NOT contract_recorded THEN
      RAISE EXCEPTION 'AUTHORITATIVE_PDF_GED_LEGACY_CLEANUP_PROFILE_INVALID';
    END IF;
    RETURN;
  END IF;

  IF NOT contract_recorded
     OR to_regclass('public.ged_entity_types') IS NULL
     OR to_regprocedure('public.fn_ged_link_guard()') IS NULL
     OR to_regprocedure('public.fn_ged_validate_canonical_entity_link_20()') IS NULL THEN
    RAISE EXCEPTION 'AUTHORITATIVE_PDF_GED_LEGACY_CLEANUP_PREREQUISITE_MISSING';
  END IF;
  IF (SELECT COUNT(*) FROM public.cerp_authoritative_pdf_ged_bridge_20260823
       WHERE singleton AND source_profile = 'LEGACY_SOL20') <> 1 THEN
    RAISE EXCEPTION 'AUTHORITATIVE_PDF_GED_LEGACY_CLEANUP_MARKER_INVALID';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ged_document_links) THEN
    RAISE EXCEPTION 'AUTHORITATIVE_PDF_GED_LEGACY_CLEANUP_LINKS_NOT_EMPTY';
  END IF;
  IF (SELECT COUNT(*) FROM public.ged_entity_types) <> 17 THEN
    RAISE EXCEPTION 'AUTHORITATIVE_PDF_GED_LEGACY_CLEANUP_REGISTRY_DRIFT';
  END IF;
  IF EXISTS (
    WITH expected(entity_type) AS (
      VALUES ('CLIENT'), ('FOURNISSEUR'), ('ARTICLE'), ('PIECE_TECHNIQUE'),
        ('PIECE_TECHNIQUE_VERSION'), ('AFFAIRE'), ('DEVIS'), ('COMMANDE_CLIENT'),
        ('COMMANDE_FOURNISSEUR'), ('OF'), ('BON_LIVRAISON'), ('RECEPTION'),
        ('CONTROLE_QUALITE'), ('MACHINE'), ('UTILISATEUR'), ('FACTURE'), ('AVOIR')
    )
    SELECT 1 FROM expected e
    LEFT JOIN public.ged_entity_types t USING (entity_type)
    WHERE t.entity_type IS NULL
  ) THEN
    RAISE EXCEPTION 'AUTHORITATIVE_PDF_GED_LEGACY_CLEANUP_REGISTRY_DRIFT';
  END IF;

  DROP TRIGGER trg_ged_link_guard ON public.ged_document_links;
  DROP FUNCTION public.fn_ged_link_guard();
  DROP TABLE public.ged_entity_types;
  DROP TABLE public.cerp_authoritative_pdf_ged_bridge_20260823;
END
$cleanup$;

COMMIT;
