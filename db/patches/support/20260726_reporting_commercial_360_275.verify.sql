-- Verify #275 — LECTURE SEULE. À exécuter APRÈS le patch.
-- Attendu : 17 index présents, aucun objet applicatif créé, aucune donnée modifiée.

\echo '=== Base ==='
SELECT current_database() AS database, now() AS checked_at;

\echo ''
\echo '=== Les 17 index #275 (status doit valoir ok partout) ==='
WITH expected(indexname, tablename) AS (
  VALUES
    ('devis_reporting_statut_creation_275_idx', 'devis'),
    ('devis_reporting_open_275_idx', 'devis'),
    ('devis_reporting_user_275_idx', 'devis'),
    ('commande_client_reporting_date_275_idx', 'commande_client'),
    ('commande_client_reporting_client_date_275_idx', 'commande_client'),
    ('commande_ligne_reporting_delai_275_idx', 'commande_ligne'),
    ('bon_livraison_reporting_expedition_275_idx', 'bon_livraison'),
    ('bon_livraison_reporting_livraison_275_idx', 'bon_livraison'),
    ('facture_reporting_statut_emission_275_idx', 'facture'),
    ('facture_reporting_client_emission_275_idx', 'facture'),
    ('facture_reporting_echeance_275_idx', 'facture'),
    ('avoir_reporting_statut_emission_275_idx', 'avoir'),
    ('avoir_reporting_facture_275_idx', 'avoir'),
    ('paiement_reporting_date_status_275_idx', 'paiement'),
    ('paiement_reporting_client_date_275_idx', 'paiement'),
    ('paiement_allocations_reporting_created_275_idx', 'paiement_allocations'),
    ('avoir_source_allocations_reporting_created_275_idx', 'avoir_source_allocations')
)
SELECT e.indexname,
       e.tablename,
       CASE WHEN i.indexname IS NULL THEN 'MANQUANT' ELSE 'ok' END AS status,
       i.indexdef
FROM expected e
LEFT JOIN pg_indexes i
  ON i.schemaname = 'public' AND i.indexname = e.indexname
ORDER BY e.tablename, e.indexname;

\echo ''
\echo '=== Compte (17 attendu) ==='
SELECT count(*) AS index_275_count
FROM pg_indexes
WHERE schemaname = 'public' AND indexname LIKE '%\_275\_idx';

\echo ''
\echo '=== Aucune table ni colonne creee par #275 (0 attendu) ==='
SELECT count(*) AS tables_275
FROM information_schema.tables
WHERE table_schema = 'public' AND table_name LIKE '%\_275';

\echo ''
\echo '=== Les index sont valides et prets (indisvalid + indisready true partout) ==='
SELECT c.relname AS indexname, i.indisvalid, i.indisready
FROM pg_class c
JOIN pg_index i ON i.indexrelid = c.oid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname LIKE '%\_275\_idx'
ORDER BY 1;

\echo ''
\echo '=== Lisibilite par le role applicatif (aucune erreur 42501 attendue) ==='
SET ROLE cerp_app;
SELECT 'devis' AS relation, count(*) FROM public.devis
UNION ALL SELECT 'commande_client', count(*) FROM public.commande_client
UNION ALL SELECT 'bon_livraison', count(*) FROM public.bon_livraison
UNION ALL SELECT 'facture', count(*) FROM public.facture
UNION ALL SELECT 'avoir', count(*) FROM public.avoir
UNION ALL SELECT 'paiement', count(*) FROM public.paiement
UNION ALL SELECT 'paiement_allocations', count(*) FROM public.paiement_allocations
UNION ALL SELECT 'avoir_source_allocations', count(*) FROM public.avoir_source_allocations
ORDER BY 1;
RESET ROLE;

\echo ''
\echo '=== Migration enregistree ==='
SELECT filename, applied_at
FROM public.cerp_schema_migrations
WHERE filename = '20260726_reporting_commercial_360_275.sql';
