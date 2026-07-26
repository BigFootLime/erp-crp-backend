-- Verify #146 — LECTURE SEULE.
-- Les six index doivent exister, être valides et prêts.

\echo '=== #146 verify — base cible ==='
SELECT current_database() AS database, now() AS checked_at;

WITH expected(indexname, tablename) AS (
  VALUES
    ('pt_operations_piece_146_idx', 'pieces_techniques_operations'),
    ('pieces_techniques_landing_146_idx', 'pieces_techniques'),
    ('pieces_techniques_ensemble_146_idx', 'pieces_techniques'),
    ('pieces_techniques_without_article_146_idx', 'pieces_techniques'),
    ('ptv_plan_reference_146_idx', 'piece_technique_versions'),
    ('ptv_indice_146_idx', 'piece_technique_versions')
)
SELECT e.indexname,
       e.tablename,
       i.indexname IS NOT NULL AS present,
       coalesce(pi.indisvalid, false) AS valid,
       coalesce(pi.indisready, false) AS ready
FROM expected e
LEFT JOIN pg_indexes i
  ON i.schemaname = 'public'
 AND i.indexname = e.indexname
LEFT JOIN pg_class pc
  ON pc.relname = e.indexname
 AND pc.relnamespace = 'public'::regnamespace
LEFT JOIN pg_index pi
  ON pi.indexrelid = pc.oid
ORDER BY e.tablename, e.indexname;

\echo '--- Compte attendu : 6 ---'
SELECT count(*) AS index_146_count
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname LIKE '%\_146\_idx';

\echo '--- Migration enregistrée ---'
SELECT filename, applied_at
FROM public.cerp_schema_migrations
WHERE filename = '20260726_pieces_techniques_landing_146.sql';

\echo '=== #146 verify terminé ==='
