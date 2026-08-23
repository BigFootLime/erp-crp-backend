-- Rollback is safe only while this patch still owns unused, exact registry rows.
BEGIN;

DO $rollback$
DECLARE
  patch_recorded boolean := false;
  target_exists boolean := false;
BEGIN
  IF to_regclass('public.cerp_schema_migrations') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.cerp_schema_migrations WHERE filename = $1)'
      INTO patch_recorded
      USING '20260823_authoritative_pdf_ged_entity_contract.sql';
  END IF;
  IF to_regclass('public.ged_entity_types') IS NOT NULL THEN
    EXECUTE $sql$
      SELECT EXISTS (
        SELECT 1 FROM public.ged_entity_types
         WHERE entity_type IN ('BON_LIVRAISON', 'DEVIS', 'COMMANDE_FOURNISSEUR', 'FACTURE', 'AVOIR')
      )
    $sql$ INTO target_exists;
  END IF;
  IF NOT patch_recorded THEN
    IF target_exists THEN
      RAISE EXCEPTION 'Rollback refused: authoritative PDF GED entity rows exist without migration-ledger ownership.';
    END IF;
    RETURN;
  END IF;
  IF to_regclass('public.ged_entity_types') IS NULL
     OR to_regclass('public.ged_document_links') IS NULL
     OR NOT target_exists THEN
    RAISE EXCEPTION 'Rollback refused: migration ledger is present but GED entity-contract artifacts are incomplete.';
  END IF;
  IF EXISTS (
    WITH expected(entity_type, label, module_key, target_table, target_pk_column, sort_order, is_active) AS (
      VALUES
        ('DEVIS',                'Devis',                'devis',                  'devis',                'id',  65, true),
        ('COMMANDE_FOURNISSEUR', 'Commande fournisseur', 'commandes-fournisseurs', 'commande_fournisseur', 'id',  75, true),
        ('BON_LIVRAISON',        'Bon de livraison',     'livraisons',             'bon_livraison',        'id',  85, true),
        ('FACTURE',              'Facture',              'facturation',            'facture',              'id', 125, true),
        ('AVOIR',                'Avoir',                'facturation',            'avoir',                'id', 130, true)
    )
    SELECT 1 FROM expected e
    LEFT JOIN public.ged_entity_types t USING (entity_type)
    WHERE t.entity_type IS NULL
       OR (t.label, t.module_key, t.target_table, t.target_pk_column, t.sort_order, t.is_active)
          IS DISTINCT FROM
          (e.label, e.module_key, e.target_table, e.target_pk_column, e.sort_order, e.is_active)
  ) THEN
    RAISE EXCEPTION 'Rollback refused: owned GED entity-contract configuration changed.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.ged_document_links
     WHERE entity_type IN ('BON_LIVRAISON', 'DEVIS', 'COMMANDE_FOURNISSEUR', 'FACTURE', 'AVOIR')
  ) THEN
    RAISE EXCEPTION 'Rollback refused: authoritative PDF GED entity links exist.';
  END IF;
  IF to_regclass('public.ged_entity_class_bindings') IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.ged_entity_class_bindings
     WHERE entity_type IN ('BON_LIVRAISON', 'DEVIS', 'COMMANDE_FOURNISSEUR', 'FACTURE', 'AVOIR')
  ) THEN
    RAISE EXCEPTION 'Rollback refused: GED class bindings reference authoritative PDF entity types.';
  END IF;

  DELETE FROM public.ged_entity_types
   WHERE entity_type IN ('BON_LIVRAISON', 'DEVIS', 'COMMANDE_FOURNISSEUR', 'FACTURE', 'AVOIR');
  EXECUTE 'DELETE FROM public.cerp_schema_migrations WHERE filename = $1'
    USING '20260823_authoritative_pdf_ged_entity_contract.sql';
END
$rollback$;

COMMIT;
