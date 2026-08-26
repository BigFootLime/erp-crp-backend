-- Read-only verification for 20260826_z_lots_scope_canonicalization.sql.
-- It intentionally does not repair values: a divergent provenance must be
-- investigated from the lot/audit history before any controlled correction.

SELECT table_name, column_name, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'lots'
  AND column_name IN ('source_scope', 'stock_scope')
ORDER BY column_name;

SELECT tgname, pg_get_triggerdef(oid) AS definition
FROM pg_trigger
WHERE tgrelid = 'public.lots'::regclass
  AND tgname = 'lots_sync_scope_columns'
  AND NOT tgisinternal;

-- Must return zero rows.  `source_scope` is canonical and `stock_scope` is a
-- temporary compatibility mirror for older stock readers.
SELECT id::text AS lot_id, lot_code, source_scope, stock_scope
FROM public.lots
WHERE source_scope IS DISTINCT FROM stock_scope
ORDER BY id;

