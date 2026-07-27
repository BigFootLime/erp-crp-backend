\set ON_ERROR_STOP on

\echo '=== Article fabrique FK validation #169 verification ==='

WITH expected(table_name, constraint_name) AS (
  VALUES
    ('commande_ligne', 'commande_ligne_article_fabrique_fk'),
    ('commande_cadre_release_ligne', 'commande_cadre_release_ligne_article_fabrique_fk'),
    ('ordres_fabrication', 'ordres_fabrication_article_fabrique_fk')
)
SELECT
  count(*) = 3 AS all_three_constraints_present,
  count(*) FILTER (WHERE fk.convalidated) = 3 AS all_three_constraints_validated
FROM expected
JOIN pg_constraint AS fk
  ON fk.conrelid = ('public.' || expected.table_name)::regclass
 AND fk.conname = expected.constraint_name
 AND fk.contype = 'f';

SELECT
  count(*) FILTER (WHERE NOT fk.convalidated) = 0
    AS all_public_foreign_keys_validated
FROM pg_constraint AS fk
WHERE fk.contype = 'f'
  AND fk.connamespace = 'public'::regnamespace;

SELECT 'commande_ligne' AS source_table, count(*) AS invalid_references
FROM public.commande_ligne AS source
LEFT JOIN public.articles_fabrique AS target ON target.article_id = source.article_id
WHERE source.article_id IS NOT NULL
  AND target.article_id IS NULL

UNION ALL

SELECT 'commande_cadre_release_ligne', count(*)
FROM public.commande_cadre_release_ligne AS source
LEFT JOIN public.articles_fabrique AS target ON target.article_id = source.article_id
WHERE source.article_id IS NOT NULL
  AND target.article_id IS NULL

UNION ALL

SELECT 'ordres_fabrication', count(*)
FROM public.ordres_fabrication AS source
LEFT JOIN public.articles_fabrique AS target ON target.article_id = source.article_id
WHERE source.article_id IS NOT NULL
  AND target.article_id IS NULL
ORDER BY source_table;
