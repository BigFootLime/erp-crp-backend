-- VERIFY db/patches/20260707_pieces_techniques_gpao_versions_gammes.sql
--
-- À exécuter sur cerp_test après la migration. Prouve : nouvelles tables/colonnes présentes,
-- possédées par cerp_app (l'app peut écrire), FK en place, ET compatibilité (les colonnes/FK
-- existantes de pieces_techniques_operations / _nomenclature sont intactes).
--   sudo -u postgres psql -d cerp_test -f db/patches/support/20260707_...verify.sql

\pset pager off

\echo '### nouvelles tables + owner (attendu: cerp_app)'
SELECT tablename, tableowner FROM pg_tables
WHERE schemaname='public' AND tablename IN ('piece_technique_versions','gammes')
ORDER BY tablename;

\echo '### colonnes ajoutées à pieces_techniques_operations (attendu: gamme_id, machine_id)'
SELECT column_name FROM information_schema.columns
WHERE table_schema='public' AND table_name='pieces_techniques_operations'
  AND column_name IN ('gamme_id','machine_id') ORDER BY column_name;

\echo '### colonnes ajoutées à pieces_techniques_nomenclature (attendu: 3)'
SELECT column_name FROM information_schema.columns
WHERE table_schema='public' AND table_name='pieces_techniques_nomenclature'
  AND column_name IN ('parent_piece_technique_version_id','child_piece_technique_version_id','child_article_id')
ORDER BY column_name;

\echo '### COMPAT — colonnes existantes de pieces_techniques_operations toujours présentes (attendu: 1)'
SELECT count(*) AS ops_existing_cols_ok FROM information_schema.columns
WHERE table_schema='public' AND table_name='pieces_techniques_operations'
  AND column_name IN ('phase','prix','coef','tp','tf_unit','qte','taux_horaire','temps_total','cout_mo')
HAVING count(*) = 9;

\echo '### COMPAT — les tables existantes restent lisibles (aucune erreur = compatible)'
SELECT
  (SELECT count(*) FROM public.pieces_techniques)              AS pieces,
  (SELECT count(*) FROM public.pieces_techniques_operations)  AS operations,
  (SELECT count(*) FROM public.pieces_techniques_nomenclature) AS nomenclature;

\echo '### FK des nouvelles tables (attendu: versions→pieces_techniques, gammes→versions, ops.gamme_id→gammes, ops.machine_id→machines, nomenclature.*→versions/articles)'
SELECT conrelid::regclass AS on_table, confrelid::regclass AS referenced_table, conname
FROM pg_constraint
WHERE contype='f' AND conrelid IN (
  'public.piece_technique_versions'::regclass,
  'public.gammes'::regclass,
  'public.pieces_techniques_operations'::regclass,
  'public.pieces_techniques_nomenclature'::regclass
) AND confrelid IN (
  'public.pieces_techniques'::regclass,'public.piece_technique_versions'::regclass,
  'public.gammes'::regclass,'public.machines'::regclass,'public.articles'::regclass
)
ORDER BY on_table, referenced_table;

\echo '### legacy déprécié (attendu: 3 commentaires DEPRECATED)'
SELECT c.relname, obj_description(c.oid) AS comment
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relname IN ('piece_technique','operation_technique','achat_technique')
ORDER BY c.relname;
