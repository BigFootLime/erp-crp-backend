-- 20260721_fournisseurs_360.verify.sql   (READ-ONLY)
--
-- Run AFTER applying db/patches/20260721_fournisseurs_360.sql to confirm the new
-- structures are present. Read-only; safe to run repeatedly.
--
--   sudo -u postgres psql -d cerp_test -f db/patches/support/20260721_fournisseurs_360.verify.sql

\echo '=== #163 verify — new tables (ok should be t) ==='
SELECT 'fournisseur_adresses' AS object, to_regclass('public.fournisseur_adresses') IS NOT NULL AS ok
UNION ALL SELECT 'fournisseur_homologations', to_regclass('public.fournisseur_homologations') IS NOT NULL
UNION ALL SELECT 'fournisseur_catalogue_prix_history', to_regclass('public.fournisseur_catalogue_prix_history') IS NOT NULL;

\echo ''
\echo '=== new catalogue columns (expect 6 rows) ==='
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema='public' AND table_name='fournisseur_catalogue'
  AND column_name IN ('incoterm','prix_multiple','valid_from','valid_to','exigence_qualite','requiert_controle_reception')
ORDER BY column_name;

\echo ''
\echo '=== constraints (expect the 4 named checks) ==='
SELECT conname
FROM pg_constraint
WHERE conname IN (
  'fournisseur_catalogue_incoterm_check',
  'fournisseur_catalogue_validity_chk',
  'fournisseur_adresses_type_check',
  'fournisseur_homologations_statut_check'
)
ORDER BY conname;

\echo ''
\echo '=== unique/partial indexes (expect the 3 guards) ==='
SELECT indexname
FROM pg_indexes
WHERE schemaname='public' AND indexname IN (
  'fournisseur_adresses_one_primary_per_type_idx',
  'fournisseur_homologations_one_current_idx',
  'fournisseur_catalogue_prix_history_catalogue_idx'
)
ORDER BY indexname;

\echo ''
\echo '=== SIRET/TVA normalized indexes (uniq preferred; *_norm_idx = duplicates were present) ==='
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname='public' AND indexname IN (
  'fournisseurs_siret_norm_uniq','fournisseurs_siret_norm_idx',
  'fournisseurs_tva_norm_uniq','fournisseurs_tva_norm_idx'
)
ORDER BY indexname;

\echo ''
\echo '=== optional catalogue devise FK (present if referential was clean) ==='
SELECT conname FROM pg_constraint WHERE conname = 'fournisseur_catalogue_devise_fkey';
