-- 20260729_piece_technique_document_policy_227.preflight.sql
-- LECTURE SEULE. À exécuter AVANT le patch #227, sur cerp_test puis (après autorisation
-- humaine) sur cerp_prod. Aucune écriture, aucun verrou long.
--   psql -d cerp_test -X -f 20260729_piece_technique_document_policy_227.preflight.sql

\echo '=== #227 preflight — base cible ==='
SELECT current_database() AS database, current_user AS role, now() AS checked_at;

\echo ''
\echo '=== 1. Tables maîtresses requises (doivent être présentes) ==='
SELECT r AS relation,
       CASE WHEN to_regclass(r) IS NULL THEN 'ABSENTE — NE PAS APPLIQUER' ELSE 'presente' END AS etat
FROM unnest(ARRAY[
  'public.clients',
  'public.pieces_techniques',
  'public.piece_technique_versions',
  'public.pieces_techniques_documents'
]) AS r;

\echo ''
\echo '=== 2. Objets créés par ce patch (attendu: absents avant, présents après) ==='
SELECT r AS relation,
       CASE WHEN to_regclass(r) IS NULL THEN 'absente (creation prevue)' ELSE 'DEJA PRESENTE (patch idempotent)' END AS etat
FROM unnest(ARRAY[
  'public.piece_document_types',
  'public.client_document_requirements',
  'public.piece_version_document_requirements',
  'public.piece_technique_create_drafts',
  'public.piece_technique_create_idempotence'
]) AS r;

\echo ''
\echo '=== 3. Colonnes ajoutées (attendu: absentes avant) ==='
SELECT table_name, column_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND (
    (table_name = 'clients' AND column_name IN ('document_policy','document_policy_updated_at','document_policy_updated_by'))
    OR (table_name = 'pieces_techniques' AND column_name IN ('piece_critique','piece_critique_motif'))
    OR (table_name = 'piece_technique_versions' AND column_name IN ('document_requirements_frozen_at','document_requirements_policy'))
    OR (table_name = 'pieces_techniques_documents' AND column_name IN ('document_type_code','piece_technique_version_id'))
  )
ORDER BY table_name, column_name;

\echo ''
\echo '=== 4. Référentiel legacy CONSERVÉ — volumétrie avant patch ==='
\echo '     (le patch ne le touche pas ; ce relevé sert de preuve de non-régression)'
SELECT 'documents_fournir' AS table_legacy,
       (SELECT count(*) FROM public.documents_fournir) AS lignes,
       (SELECT count(*) FROM public.clients WHERE provided_documents_id IS NOT NULL) AS clients_rattaches;

\echo ''
\echo '=== 5. Volumétrie des tables impactées (doit être identique après patch) ==='
SELECT 'clients' AS relation, count(*) AS lignes FROM public.clients
UNION ALL SELECT 'pieces_techniques', count(*) FROM public.pieces_techniques
UNION ALL SELECT 'piece_technique_versions', count(*) FROM public.piece_technique_versions
UNION ALL SELECT 'pieces_techniques_documents', count(*) FROM public.pieces_techniques_documents;

\echo ''
\echo '=== 6. Classes GED disponibles pour le rattachement optionnel ==='
SELECT class_key, label
FROM public.ged_document_classes
WHERE class_key IN ('PLAN_CLIENT','CERTIF_MATIERE','RELEVE_CONTROLE')
ORDER BY class_key;

\echo ''
\echo '=== 7. Rôle applicatif cerp_app (attendu: présent) ==='
SELECT rolname FROM pg_roles WHERE rolname = 'cerp_app';

\echo ''
\echo '=== 8. Patch déjà enregistré ? ==='
SELECT filename, applied_at
FROM public.cerp_schema_migrations
WHERE filename = '20260729_piece_technique_document_policy_227.sql';
