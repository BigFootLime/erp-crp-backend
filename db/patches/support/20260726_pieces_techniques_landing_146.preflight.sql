-- Préflight #146 — LECTURE SEULE.
-- Confirme les prérequis et dimensionne le coût des six index de lecture.

\echo '=== #146 preflight — base cible ==='
SELECT current_database() AS database, current_user AS role, now() AS checked_at;

\echo '--- Tables requises ---'
SELECT relation,
       to_regclass('public.' || relation) IS NOT NULL AS present
FROM unnest(ARRAY[
  'pieces_techniques',
  'piece_technique_versions',
  'pieces_techniques_operations',
  'pieces_techniques_nomenclature',
  'pieces_techniques_achats',
  'pieces_techniques_documents'
]) AS relation
ORDER BY present, relation;

\echo '--- Colonnes utilisées par les index ---'
WITH expected(table_name, column_name) AS (
  VALUES
    ('pieces_techniques_operations', 'piece_technique_id'),
    ('pieces_techniques', 'updated_at'),
    ('pieces_techniques', 'deleted_at'),
    ('pieces_techniques', 'ensemble'),
    ('pieces_techniques', 'article_id'),
    ('piece_technique_versions', 'plan_reference'),
    ('piece_technique_versions', 'indice')
)
SELECT e.table_name, e.column_name,
       c.column_name IS NOT NULL AS present
FROM expected e
LEFT JOIN information_schema.columns c
  ON c.table_schema = 'public'
 AND c.table_name = e.table_name
 AND c.column_name = e.column_name
ORDER BY present, e.table_name, e.column_name;

\echo '--- Index #146 déjà présents (0 attendu avant première application) ---'
SELECT indexname, tablename, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname LIKE '%\_146\_idx'
ORDER BY tablename, indexname;

\echo '--- Volumétrie des relations indexées ---'
SELECT 'pieces_techniques' AS relation, count(*) AS rows
FROM public.pieces_techniques
UNION ALL
SELECT 'piece_technique_versions', count(*)
FROM public.piece_technique_versions
UNION ALL
SELECT 'pieces_techniques_operations', count(*)
FROM public.pieces_techniques_operations
ORDER BY relation;

\echo '=== #146 preflight terminé ==='
