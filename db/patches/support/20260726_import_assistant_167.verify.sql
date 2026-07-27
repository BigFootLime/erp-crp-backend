\set ON_ERROR_STOP on

SELECT
  to_regclass('public.data_import_batches') IS NOT NULL AS batches_ok,
  to_regclass('public.data_import_rows') IS NOT NULL AS rows_ok,
  to_regclass('public.data_import_crosswalk') IS NOT NULL AS crosswalk_ok,
  to_regclass('public.data_import_confirm_idempotency') IS NOT NULL AS confirm_idempotency_ok,
  to_regclass('public.fournisseur_create_idempotence') IS NOT NULL AS fournisseur_idempotency_ok,
  to_regclass('public.piece_technique_create_idempotence') IS NOT NULL AS piece_idempotency_ok,
  to_regprocedure('public.fn_purge_expired_import_staging()') IS NOT NULL AS retention_function_ok;

SELECT EXISTS (
  SELECT 1
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'data_import_rows'
    AND column_name = 'purged_at'
) AS purged_at_ok;

SELECT
  count(*) FILTER (WHERE indexname = 'data_import_batches_source_uq') = 1 AS batch_source_unique_ok,
  count(*) FILTER (WHERE indexname = 'data_import_rows_batch_status_idx') = 1 AS row_claim_index_ok,
  count(*) FILTER (WHERE indexname = 'data_import_crosswalk_target_idx') = 1 AS crosswalk_target_index_ok
FROM pg_indexes
WHERE schemaname = 'public';
