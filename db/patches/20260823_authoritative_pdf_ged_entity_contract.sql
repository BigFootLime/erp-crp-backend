-- Hotfix — align every authoritative-PDF producer with GED's closed entity registry.
--
-- Strictly additive and deliberately one-shot. The five rows below were not
-- part of the historical #360 registry, but are already supported business
-- parents at the GED byte-authorization boundary.

BEGIN;

DO $guard$
BEGIN
  IF to_regclass('public.ged_entity_types') IS NULL
     OR to_regclass('public.ged_document_links') IS NULL
     OR to_regprocedure('public.fn_ged_link_guard()') IS NULL THEN
    RAISE EXCEPTION 'AUTHORITATIVE_PDF_GED_ENTITY_CONTRACT_PREREQUISITE_MISSING';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'trg_ged_link_guard'
       AND tgrelid = 'public.ged_document_links'::regclass
       AND tgfoid = to_regprocedure('public.fn_ged_link_guard()')
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'AUTHORITATIVE_PDF_GED_ENTITY_CONTRACT_LINK_GUARD_MISSING';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.ged_entity_types
     WHERE entity_type IN ('BON_LIVRAISON', 'DEVIS', 'COMMANDE_FOURNISSEUR', 'FACTURE', 'AVOIR')
  ) THEN
    RAISE EXCEPTION 'AUTHORITATIVE_PDF_GED_ENTITY_CONTRACT_TARGET_ALREADY_EXISTS';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.ged_document_links
     WHERE entity_type IN ('BON_LIVRAISON', 'DEVIS', 'COMMANDE_FOURNISSEUR', 'FACTURE', 'AVOIR')
  ) THEN
    RAISE EXCEPTION 'AUTHORITATIVE_PDF_GED_ENTITY_CONTRACT_UNREGISTERED_LINK_EXISTS';
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
    RAISE EXCEPTION 'AUTHORITATIVE_PDF_GED_ENTITY_CONTRACT_PARENT_TABLE_MISSING';
  END IF;
END
$guard$;

INSERT INTO public.ged_entity_types
  (entity_type, label, module_key, target_table, target_pk_column, sort_order, is_active)
VALUES
  ('DEVIS',                  'Devis',                'devis',                  'devis',                  'id',  65, true),
  ('COMMANDE_FOURNISSEUR',   'Commande fournisseur', 'commandes-fournisseurs', 'commande_fournisseur',   'id',  75, true),
  ('BON_LIVRAISON',          'Bon de livraison',     'livraisons',             'bon_livraison',          'id',  85, true),
  ('FACTURE',                'Facture',              'facturation',            'facture',                'id', 125, true),
  ('AVOIR',                  'Avoir',                'facturation',            'avoir',                  'id', 130, true);

COMMIT;
