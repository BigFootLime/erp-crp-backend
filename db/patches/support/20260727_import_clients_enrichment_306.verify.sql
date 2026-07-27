\set ON_ERROR_STOP on

SELECT
  current_database() = 'cerp_test' AS is_test_database,
  to_regclass('public.client_contact_create_idempotency') IS NOT NULL AS has_contact_idempotency;

SELECT
  pg_get_constraintdef(oid) LIKE '%CLIENT_ENRICHISSEMENT%' AS allows_client_enrichment,
  pg_get_constraintdef(oid) LIKE '%CLIENT_CONTACT%' AS allows_client_contact
FROM pg_constraint
WHERE conrelid = 'public.data_import_batches'::regclass
  AND conname = 'data_import_batches_entity_ck';
