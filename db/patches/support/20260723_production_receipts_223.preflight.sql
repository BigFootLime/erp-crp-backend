\set ON_ERROR_STOP on

-- Read-only preflight for issue #223. Run against cerp_test before the patch.
SELECT current_database() AS database_name, current_user AS database_user, now() AS checked_at;

SELECT prerequisite, present
FROM (
  VALUES
    ('ordres_fabrication', to_regclass('public.ordres_fabrication') IS NOT NULL),
    ('of_output_lots', to_regclass('public.of_output_lots') IS NOT NULL),
    ('lots', to_regclass('public.lots') IS NOT NULL),
    ('stock_levels', to_regclass('public.stock_levels') IS NOT NULL),
    ('stock_batches', to_regclass('public.stock_batches') IS NOT NULL),
    ('stock_movements', to_regclass('public.stock_movements') IS NOT NULL),
    ('stock_reservations', to_regclass('public.stock_reservations') IS NOT NULL),
    ('non_conformity', to_regclass('public.non_conformity') IS NOT NULL)
) AS checks(prerequisite, present)
ORDER BY prerequisite;

-- Ambiguous article/batch codes would make the safe backfill non-deterministic.
SELECT sl.article_id, sb.batch_code::text, count(DISTINCT l.id) AS matching_lots
FROM public.stock_batches sb
JOIN public.stock_levels sl ON sl.id = sb.stock_level_id
JOIN public.lots l
  ON l.article_id = sl.article_id
 AND l.lot_code::text = sb.batch_code::text
GROUP BY sl.article_id, sb.batch_code
HAVING count(DISTINCT l.id) > 1;

SELECT
  (SELECT count(*) FROM public.stock_batches) AS stock_batches,
  (SELECT count(*) FROM public.stock_reservations WHERE status = 'ACTIVE') AS active_reservations,
  (SELECT count(*) FROM public.of_output_lots) AS output_lots,
  (SELECT count(*) FROM public.non_conformity WHERE status = 'OPEN') AS open_non_conformities;
