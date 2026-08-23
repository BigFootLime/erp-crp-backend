-- Authoritative PDF/GED entity contract verification — read-only exact-state proof.
BEGIN TRANSACTION READ ONLY;

DO $verify$
BEGIN
  IF to_regclass('public.ged_entity_types') IS NULL
     OR to_regclass('public.ged_document_links') IS NULL
     OR to_regprocedure('public.fn_ged_link_guard()') IS NULL THEN
    RAISE EXCEPTION 'AUTHORITATIVE_PDF_GED_ENTITY_CONTRACT_VERIFY_PREREQUISITE_MISSING';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'trg_ged_link_guard'
       AND tgrelid = 'public.ged_document_links'::regclass
       AND tgfoid = to_regprocedure('public.fn_ged_link_guard()')
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'AUTHORITATIVE_PDF_GED_ENTITY_CONTRACT_VERIFY_LINK_GUARD_MISSING';
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
    SELECT 1
      FROM expected e
      LEFT JOIN public.ged_entity_types t USING (entity_type)
     WHERE t.entity_type IS NULL
        OR (t.label, t.module_key, t.target_table, t.target_pk_column, t.sort_order, t.is_active)
           IS DISTINCT FROM
           (e.label, e.module_key, e.target_table, e.target_pk_column, e.sort_order, e.is_active)
  ) THEN
    RAISE EXCEPTION 'AUTHORITATIVE_PDF_GED_ENTITY_CONTRACT_VERIFY_ROW_MISMATCH';
  END IF;
END
$verify$;

SELECT
  COUNT(*) = 5 AS all_required_types_present,
  bool_and(is_active) AS all_required_types_active
FROM public.ged_entity_types
WHERE entity_type IN ('BON_LIVRAISON', 'DEVIS', 'COMMANDE_FOURNISSEUR', 'FACTURE', 'AVOIR');

COMMIT;
