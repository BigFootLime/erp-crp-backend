-- Read-only post-patch checks; do not mutate production data.
SELECT
  EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'lots'
      AND column_name = 'piece_technique_version_id'
  ) AS lot_revision_exists,
  EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'stock_inventory_sessions'
      AND column_name = 'scope_article_prefix'
  ) AS inventory_prefix_exists,
  to_regclass('public.lots_piece_technique_version_idx') IS NOT NULL AS lot_revision_index_exists,
  EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'lots_piece_technique_version_fkey'
      AND conrelid = 'public.lots'::regclass
  ) AS lot_revision_fk_exists;

SELECT
  COUNT(*) FILTER (WHERE piece_technique_version_id IS NOT NULL)::int AS revisioned_lots,
  COUNT(*) FILTER (WHERE piece_technique_version_id IS NULL)::int AS unscoped_lots
FROM public.lots;

