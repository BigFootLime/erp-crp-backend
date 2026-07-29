-- 20260729_piece_technique_document_policy_227.verify.sql
-- LECTURE SEULE. À exécuter APRÈS le patch #227.
--   psql -d cerp_test -X -f 20260729_piece_technique_document_policy_227.verify.sql
-- Toute ligne marquée ECHEC invalide l'application du patch.

\echo '=== #227 verify — base cible ==='
SELECT current_database() AS database, now() AS checked_at;

\echo ''
\echo '=== 1. Tables créées ==='
SELECT r AS relation,
       CASE WHEN to_regclass(r) IS NULL THEN 'ECHEC — absente' ELSE 'OK' END AS etat
FROM unnest(ARRAY[
  'public.piece_document_types',
  'public.client_document_requirements',
  'public.piece_version_document_requirements',
  'public.piece_technique_create_drafts',
  'public.piece_technique_create_idempotence'
]) AS r;

\echo ''
\echo '=== 2. Colonnes ajoutées (attendu: 9 lignes) ==='
SELECT table_name, column_name, data_type, column_default
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
\echo '=== 3. Contraintes de politique (attendu: 3 CHECK) ==='
SELECT conname,
       CASE WHEN conname IS NULL THEN 'ECHEC' ELSE 'OK' END AS etat
FROM pg_constraint
WHERE conname IN (
  'clients_document_policy_chk',
  'piece_version_document_requirements_policy_chk',
  'piece_technique_versions_doc_policy_chk',
  'piece_document_types_code_format_chk'
)
ORDER BY conname;

\echo ''
\echo '=== 4. Référentiel amorcé (attendu: les 6 types fondateurs, is_system = true) ==='
SELECT code, label, ged_class_key, is_system, is_active, sort_order
FROM public.piece_document_types
ORDER BY sort_order, code;

\echo ''
\echo '=== 5. Les 6 types fondateurs sont bien présents ==='
SELECT CASE WHEN count(*) = 6 THEN 'OK — 6/6' ELSE 'ECHEC — ' || count(*) || '/6' END AS etat
FROM public.piece_document_types
WHERE code IN ('PLAN','CERTIF_MATIERE','CC_CCPU','BL_CERTIFIE','CERTIF_TRAITEMENT','RAPPORT_CONTROLE')
  AND is_system;

\echo ''
\echo '=== 6. Défaut de politique — aucun client ne change de comportement ==='
\echo '     (attendu: 100 % des clients en NONE juste après le patch)'
SELECT document_policy, count(*) AS clients
FROM public.clients
GROUP BY document_policy
ORDER BY 1;

\echo ''
\echo '=== 7. Non-régression : le référentiel legacy est INTACT ==='
SELECT 'documents_fournir' AS table_legacy,
       CASE WHEN to_regclass('public.documents_fournir') IS NULL
            THEN 'ECHEC — table legacy supprimee'
            ELSE 'OK — conservee' END AS etat,
       (SELECT count(*) FROM public.documents_fournir) AS lignes;

SELECT 'clients.provided_documents_id' AS colonne_legacy,
       CASE WHEN EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema='public' AND table_name='clients' AND column_name='provided_documents_id'
       ) THEN 'OK — conservee' ELSE 'ECHEC — colonne legacy supprimee' END AS etat;

\echo ''
\echo '=== 8. Aucune pièce technique perdue, aucun document perdu ==='
SELECT 'pieces_techniques' AS relation, count(*) AS lignes FROM public.pieces_techniques
UNION ALL SELECT 'piece_technique_versions', count(*) FROM public.piece_technique_versions
UNION ALL SELECT 'pieces_techniques_documents', count(*) FROM public.pieces_techniques_documents
UNION ALL SELECT 'clients', count(*) FROM public.clients;

\echo ''
\echo '=== 9. piece_critique — défaut faux, donc aucune pièce ne devient critique ==='
SELECT CASE WHEN count(*) = 0 THEN 'OK — 0 piece critique' ELSE 'ATTENTION — ' || count(*) || ' pieces critiques' END AS etat
FROM public.pieces_techniques WHERE piece_critique;

\echo ''
\echo '=== 10. Aucune version n''a été gelée par le patch ==='
SELECT CASE WHEN count(*) = 0 THEN 'OK — aucun gel retroactif' ELSE 'ECHEC — ' || count(*) || ' versions gelees' END AS etat
FROM public.piece_technique_versions WHERE document_requirements_frozen_at IS NOT NULL;

\echo ''
\echo '=== 11. Propriété applicative (attendu: cerp_app sur les 5 tables) ==='
SELECT c.relname AS relation, pg_get_userbyid(c.relowner) AS proprietaire,
       CASE WHEN pg_get_userbyid(c.relowner) = 'cerp_app' THEN 'OK' ELSE 'ECHEC — 42501 attendu cote API' END AS etat
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN (
    'piece_document_types',
    'client_document_requirements',
    'piece_version_document_requirements',
    'piece_technique_create_drafts',
    'piece_technique_create_idempotence'
  )
ORDER BY c.relname;

\echo ''
\echo '=== 12. Lecture effective par le rôle applicatif ==='
SET ROLE cerp_app;
SELECT count(*) AS types_lisibles_par_cerp_app FROM public.piece_document_types;
SELECT count(*) AS exigences_lisibles_par_cerp_app FROM public.client_document_requirements;
RESET ROLE;

\echo ''
\echo '=== 13. Index attendus ==='
SELECT indexname
FROM pg_indexes
WHERE schemaname = 'public' AND indexname LIKE '%\_227\_idx'
ORDER BY indexname;
