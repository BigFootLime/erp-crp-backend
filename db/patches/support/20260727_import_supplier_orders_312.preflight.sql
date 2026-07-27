\set ON_ERROR_STOP on

SELECT current_database() = 'cerp_test' AS is_test_database;

SELECT
  to_regclass('public.data_import_batches') IS NOT NULL AS has_import_batches,
  to_regclass('public.data_import_crosswalk') IS NOT NULL AS has_crosswalks,
  to_regclass('public.commande_fournisseur') IS NOT NULL AS has_supplier_orders,
  to_regclass('public.commande_fournisseur_ligne') IS NOT NULL AS has_supplier_order_lines,
  to_regclass('public.commande_fournisseur_idempotence') IS NOT NULL AS has_supplier_order_idempotency;

SELECT pg_get_constraintdef(oid) AS current_entity_constraint
FROM pg_constraint
WHERE conrelid = 'public.data_import_batches'::regclass
  AND conname = 'data_import_batches_entity_ck';
