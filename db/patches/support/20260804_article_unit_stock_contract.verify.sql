-- #475 verification (READ-ONLY). Run after applying the patch on cerp_test.

\echo '=== #475 verify — canonical units (expect u, mm, m, kg) ==='
SELECT lower(code::text) AS code, label, count(*) AS matching_rows
FROM public.units
WHERE lower(code::text) IN ('u', 'mm', 'm', 'kg')
GROUP BY lower(code::text), label
ORDER BY code;

SELECT (count(*) <> 4)::text AS canonical_seed_invalid
FROM public.units WHERE lower(code::text) IN ('u', 'mm', 'm', 'kg') \gset
\if :canonical_seed_invalid
  \echo 'BLOCKING: canonical unit seeds are missing or duplicated case-insensitively.'
  \quit 3
\endif

\echo ''
\echo '=== Rollback provenance ==='
SELECT code, unit_id, inserted_by_patch FROM public.cerp_patch_20260804_stock_units ORDER BY code;

SELECT (
  count(*) <> 3
  OR bool_or(u.id IS NULL)
)::text AS rollback_provenance_invalid
FROM public.cerp_patch_20260804_stock_units marker
LEFT JOIN public.units u
  ON u.id::text = marker.unit_id
 AND lower(u.code::text) = marker.code \gset
\if :rollback_provenance_invalid
  \echo 'BLOCKING: rollback provenance is incomplete or no longer identifies the exact seeded rows.'
  \quit 3
\endif

\echo ''
\echo '=== Article values unresolved through canonical aliases (expect 0 rows) ==='
WITH normalized AS (
  SELECT unite,
    CASE
      WHEN lower(btrim(unite)) IN ('pc','pce','pces','pcs','piece','pieces','pièce','pièces','unit','units','unite','unites','unité','unités') THEN 'u'
      ELSE lower(btrim(unite))
    END AS canonical
  FROM public.articles
  WHERE unite IS NOT NULL AND btrim(unite) <> ''
)
SELECT n.unite, n.canonical, count(*) AS articles
FROM normalized n
LEFT JOIN public.units u ON lower(u.code::text) = n.canonical
WHERE u.code IS NULL
GROUP BY n.unite, n.canonical
ORDER BY articles DESC, n.unite;

WITH normalized AS (
  SELECT CASE
    WHEN lower(btrim(unite)) IN ('pc','pce','pces','pcs','piece','pieces','pièce','pièces','unit','units','unite','unites','unité','unités') THEN 'u'
    ELSE lower(btrim(unite))
  END AS canonical
  FROM public.articles
  WHERE unite IS NOT NULL AND btrim(unite) <> ''
)
SELECT (count(*) > 0)::text AS has_unresolved
FROM normalized n LEFT JOIN public.units u ON lower(u.code::text) = n.canonical
WHERE u.code IS NULL \gset
\if :has_unresolved
  \echo 'BLOCKING: unresolved article units remain. Add an explicit alias or canonical seed before rollout.'
  \quit 3
\endif
