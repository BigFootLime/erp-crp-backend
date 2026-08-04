-- #475 preflight (READ-ONLY). Run on cerp_test before the additive patch.

\echo '=== #475 preflight — confirm the target is not production ==='
SELECT current_database() AS database, current_user AS role, inet_server_addr() AS server_addr;

SELECT (to_regclass('public.units') IS NULL)::text AS units_missing \gset
\if :units_missing
  \echo 'BLOCKING: public.units is missing. Apply the stock foundation patches first.'
  \quit 3
\endif

SELECT (NOT EXISTS (SELECT 1 FROM public.units WHERE lower(code::text) = 'u'))::text AS base_unit_missing \gset
\if :base_unit_missing
  \echo 'BLOCKING: canonical base unit u is missing. Apply 20260223_seed_currencies_units.sql first.'
  \quit 3
\endif

\echo ''
\echo '=== Case-insensitive duplicate unit codes (expect 0 rows) ==='
SELECT lower(code::text) AS canonical, count(*) AS matching_rows
FROM public.units
GROUP BY lower(code::text)
HAVING count(*) > 1
ORDER BY canonical;

SELECT EXISTS (
  SELECT 1 FROM public.units GROUP BY lower(code::text) HAVING count(*) > 1
)::text AS has_case_duplicates \gset
\if :has_case_duplicates
  \echo 'BLOCKING: case-insensitive duplicate unit codes make resolution ambiguous. Reconcile them before applying this patch.'
  \quit 3
\endif

\echo ''
\echo '=== Existing/planned canonical codes ==='
SELECT code, label FROM public.units WHERE lower(code::text) IN ('u', 'mm', 'm', 'kg') ORDER BY code;

\echo ''
\echo '=== Existing article values unresolved after aliases + planned seeds ==='
WITH normalized AS (
  SELECT unite,
    CASE
      WHEN lower(btrim(unite)) IN ('pc','pce','pces','pcs','piece','pieces','pièce','pièces','unit','units','unite','unites','unité','unités') THEN 'u'
      ELSE lower(btrim(unite))
    END AS canonical
  FROM public.articles
  WHERE unite IS NOT NULL AND btrim(unite) <> ''
), available AS (
  SELECT lower(code::text) AS code FROM public.units
  UNION SELECT unnest(ARRAY['u','mm','m','kg'])
)
SELECT n.unite, n.canonical, count(*) AS articles
FROM normalized n
LEFT JOIN available a ON a.code = n.canonical
WHERE a.code IS NULL
GROUP BY n.unite, n.canonical
ORDER BY articles DESC, n.unite;

WITH normalized AS (
  SELECT CASE
    WHEN lower(btrim(unite)) IN ('pc','pce','pces','pcs','piece','pieces','pièce','pièces','unit','units','unite','unites','unité','unités') THEN 'u'
    ELSE lower(btrim(unite))
  END AS canonical
  FROM public.articles
  WHERE unite IS NOT NULL AND btrim(unite) <> ''
), available AS (
  SELECT lower(code::text) AS code FROM public.units
  UNION SELECT unnest(ARRAY['u','mm','m','kg'])
)
SELECT (count(*) > 0)::text AS has_unresolved
FROM normalized n LEFT JOIN available a ON a.code = n.canonical
WHERE a.code IS NULL \gset
\if :has_unresolved
  \echo 'BLOCKING: unresolved article units remain. Add an explicit alias or canonical seed; never guess a quantity conversion.'
  \quit 3
\endif
