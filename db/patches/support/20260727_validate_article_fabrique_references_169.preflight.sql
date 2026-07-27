\set ON_ERROR_STOP on

\echo '=== Article fabrique FK validation #169 preflight (read-only) ==='

SELECT
  current_database() AS database,
  current_database() IN ('cerp_test', 'cerp_prod') AS allowed_database;

WITH expected(table_name, constraint_name) AS (
  VALUES
    ('commande_ligne', 'commande_ligne_article_fabrique_fk'),
    ('commande_cadre_release_ligne', 'commande_cadre_release_ligne_article_fabrique_fk'),
    ('ordres_fabrication', 'ordres_fabrication_article_fabrique_fk')
)
SELECT
  expected.table_name,
  expected.constraint_name,
  fk.oid IS NOT NULL AS exists,
  COALESCE(fk.contype = 'f', false) AS is_foreign_key,
  COALESCE(
    pg_get_constraintdef(fk.oid)
      = 'FOREIGN KEY (article_id) REFERENCES articles_fabrique(article_id) NOT VALID',
    false
  ) OR COALESCE(
    pg_get_constraintdef(fk.oid)
      = 'FOREIGN KEY (article_id) REFERENCES articles_fabrique(article_id)',
    false
  ) AS definition_ok,
  COALESCE(fk.convalidated, false) AS already_validated
FROM expected
LEFT JOIN pg_constraint AS fk
  ON fk.conrelid = ('public.' || expected.table_name)::regclass
 AND fk.conname = expected.constraint_name
ORDER BY expected.table_name;

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

\echo 'Preflight #169 complete: every reported invalid_references value must be zero.'
