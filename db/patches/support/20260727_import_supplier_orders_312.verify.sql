\set ON_ERROR_STOP on

SELECT current_database() = 'cerp_test' AS is_test_database;

SELECT
  pg_get_constraintdef(oid) LIKE '%FOURNISSEUR_COMMANDE%' AS allows_supplier_order,
  pg_get_constraintdef(oid) LIKE '%FOURNISSEUR%' AS keeps_supplier,
  pg_get_constraintdef(oid) LIKE '%ARTICLE%' AS keeps_article
FROM pg_constraint
WHERE conrelid = 'public.data_import_batches'::regclass
  AND conname = 'data_import_batches_entity_ck';

SELECT count(*) = 0 AS no_non_test_supplier_order_batch
FROM public.data_import_batches
WHERE entity_type = 'FOURNISSEUR_COMMANDE'
  AND source_system <> 'CLIPPER';
