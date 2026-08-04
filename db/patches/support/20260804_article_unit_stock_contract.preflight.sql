-- #475 preflight (READ-ONLY). Run on cerp_test before the additive patch.

\echo '=== #475 preflight — confirm the target is not production ==='
SELECT current_database() AS database, current_user AS role, inet_server_addr() AS server_addr;

\echo ''
\echo '=== Required canonical referential (present must be true) ==='
SELECT to_regclass('public.units') IS NOT NULL AS units_table_present;

\echo ''
\echo '=== Existing unit codes (mm may be absent before apply) ==='
SELECT code, label FROM public.units WHERE code IN ('u', 'mm') ORDER BY code;

\echo ''
\echo '=== Existing article values that would remain unresolved (investigate before enforcing) ==='
SELECT a.unite, count(*) AS articles
FROM public.articles a
LEFT JOIN public.units u ON u.code = a.unite
WHERE a.unite IS NOT NULL AND btrim(a.unite) <> '' AND u.code IS NULL
GROUP BY a.unite
ORDER BY articles DESC, a.unite;
