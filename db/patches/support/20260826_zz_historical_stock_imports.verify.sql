-- Read-only verification for 20260826_zz_historical_stock_imports.sql.
-- Run after the patch, before enabling the historical-import endpoint.

SELECT
  to_regclass('public.historical_stock_import_receipts') IS NOT NULL AS receipt_table_exists,
  to_regclass('public.lots') IS NOT NULL AS lots_table_exists,
  to_regclass('public.stock_movements') IS NOT NULL AS movements_table_exists;

SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'historical_stock_import_receipts'
  AND column_name IN (
    'id', 'actor_user_id', 'idempotency_key', 'request_hash', 'request_payload',
    'article_id', 'lot_id', 'movement_id', 'result_payload', 'created_at'
  )
ORDER BY column_name;

SELECT conname, contype, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'public.historical_stock_import_receipts'::regclass
  AND conname IN (
    'historical_stock_import_receipts_key_len_chk',
    'historical_stock_import_receipts_hash_chk',
    'historical_stock_import_receipts_actor_key_uniq'
  )
ORDER BY conname;

SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename = 'historical_stock_import_receipts'
  AND indexname IN (
    'historical_stock_import_receipts_actor_key_uniq',
    'historical_stock_import_receipts_created_idx'
  )
ORDER BY indexname;

-- Any row returned below needs an operator review. A completed receipt must
-- point to one coherent article/lot/movement and the lot must remain OLD.
SELECT
  r.id,
  r.actor_user_id,
  r.idempotency_key,
  r.created_at,
  r.article_id,
  r.lot_id,
  r.movement_id,
  l.source_scope,
  l.stock_scope,
  m.status AS movement_status,
  m.movement_type,
  m.source_document_type
FROM public.historical_stock_import_receipts r
LEFT JOIN public.lots l ON l.id = r.lot_id
LEFT JOIN public.stock_movements m ON m.id = r.movement_id
WHERE r.result_payload IS NULL
   OR r.article_id IS NULL
   OR r.lot_id IS NULL
   OR r.movement_id IS NULL
   OR l.article_id IS DISTINCT FROM r.article_id
   OR COALESCE(l.source_scope, l.stock_scope, 'NEW') <> 'OLD'
   OR m.article_id IS DISTINCT FROM r.article_id
   OR m.status <> 'POSTED'
   OR m.movement_type <> 'IN'::public.movement_type
   OR m.source_document_type <> 'HISTORICAL_IMPORT'
ORDER BY r.created_at DESC, r.id;

-- A receipt result is immutable business evidence. Check that no movement key
-- can be shared by two receipts, even if an operator performed manual repair.
SELECT movement_id, COUNT(*) AS receipt_count
FROM public.historical_stock_import_receipts
WHERE movement_id IS NOT NULL
GROUP BY movement_id
HAVING COUNT(*) > 1;
