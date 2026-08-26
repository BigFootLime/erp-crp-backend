-- Read-only post-patch checks; do not mutate production data.
SELECT
  to_regclass('public.article_category_referential') IS NOT NULL AS category_referential_exists,
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'pieces_techniques' AND column_name = 'piece_critique'
  ) AS pt_criticality_exists,
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'lots' AND column_name = 'stock_scope'
  ) AS lot_scope_exists;

SELECT code, is_active, sort_order
FROM public.article_category_referential
ORDER BY sort_order, code;
