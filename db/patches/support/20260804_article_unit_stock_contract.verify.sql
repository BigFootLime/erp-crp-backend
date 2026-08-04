-- #475 verification (READ-ONLY). Run after applying the patch on cerp_test.

\echo '=== #475 verify — mm must be present exactly once ==='
SELECT code, label, count(*) OVER (PARTITION BY code) AS matching_rows
FROM public.units
WHERE code = 'mm';

\echo ''
\echo '=== Rollback marker (true means this patch inserted mm) ==='
SELECT singleton, inserted_by_patch FROM public.cerp_patch_20260804_unit_mm;

\echo ''
\echo '=== Article values absent from the canonical referential (expect 0 rows) ==='
SELECT a.unite, count(*) AS articles
FROM public.articles a
LEFT JOIN public.units u ON u.code = a.unite
WHERE a.unite IS NOT NULL AND btrim(a.unite) <> '' AND u.code IS NULL
GROUP BY a.unite
ORDER BY articles DESC, a.unite;
