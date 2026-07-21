-- 20260721_fournisseurs_360.preflight.sql   (READ-ONLY)
--
-- Run BEFORE applying db/patches/20260721_fournisseurs_360.sql — on cerp_test first,
-- and AGAIN before any cerp_prod decision. It reports the environment, prerequisites,
-- data volumes, and anything that would block the uniqueness/FK additions.
-- It NEVER writes and performs NO automatic mapping.
--
--   sudo -u postgres psql -d cerp_test -f db/patches/support/20260721_fournisseurs_360.preflight.sql

\echo '=== #163 preflight — ENVIRONMENT (confirm this is NOT cerp_prod before applying) ==='
SELECT current_database() AS database, current_user AS role, inet_server_addr() AS server_addr;

\echo ''
\echo '=== Prerequisites (present should be t where required) ==='
SELECT 'fournisseurs (canonical)'            AS object, to_regclass('public.fournisseurs') IS NOT NULL AS present
UNION ALL SELECT 'fournisseur_contacts',          to_regclass('public.fournisseur_contacts') IS NOT NULL
UNION ALL SELECT 'fournisseur_catalogue',         to_regclass('public.fournisseur_catalogue') IS NOT NULL
UNION ALL SELECT 'fournisseur_documents',         to_regclass('public.fournisseur_documents') IS NOT NULL
UNION ALL SELECT 'fournisseur_domaines',          to_regclass('public.fournisseur_domaines') IS NOT NULL
UNION ALL SELECT 'fournisseur_domaine_lien',      to_regclass('public.fournisseur_domaine_lien') IS NOT NULL
UNION ALL SELECT 'fournisseur_events',            to_regclass('public.fournisseur_events') IS NOT NULL
UNION ALL SELECT 'fournisseur_outillage_mapping', to_regclass('public.fournisseur_outillage_mapping') IS NOT NULL
UNION ALL SELECT 'gestion_outils_fournisseur (legacy)', to_regclass('public.gestion_outils_fournisseur') IS NOT NULL
UNION ALL SELECT 'currencies (referential)',      to_regclass('public.currencies') IS NOT NULL
UNION ALL SELECT 'units (referential)',           to_regclass('public.units') IS NOT NULL
UNION ALL SELECT 'erp_audit_logs',                to_regclass('public.erp_audit_logs') IS NOT NULL
UNION ALL SELECT 'tg_set_updated_at()',           to_regproc('public.tg_set_updated_at()') IS NOT NULL
UNION ALL SELECT 'fn_next_issued_code_value()',   EXISTS(SELECT 1 FROM pg_proc WHERE proname = 'fn_next_issued_code_value');

\echo ''
\echo '=== Supplier data volumes ==='
SELECT 'fournisseurs' AS tbl, count(*) AS rows FROM public.fournisseurs
UNION ALL SELECT 'fournisseur_contacts', count(*) FROM public.fournisseur_contacts
UNION ALL SELECT 'fournisseur_catalogue', count(*) FROM public.fournisseur_catalogue
UNION ALL SELECT 'fournisseur_documents', count(*) FROM public.fournisseur_documents
UNION ALL SELECT 'fournisseur_domaine_lien', count(*) FROM public.fournisseur_domaine_lien
UNION ALL SELECT 'fournisseur_events', count(*) FROM public.fournisseur_events
UNION ALL SELECT 'fournisseur_outillage_mapping', count(*) FROM public.fournisseur_outillage_mapping;

\echo ''
\echo '=== Ghost tables from the 2026-07-07 note (present should be f) ==='
SELECT 'business_partners' AS object, to_regclass('public.business_partners') IS NOT NULL AS present
UNION ALL SELECT 'suppliers', to_regclass('public.suppliers') IS NOT NULL
UNION ALL SELECT 'supplier_articles', to_regclass('public.supplier_articles') IS NOT NULL;

\echo ''
\echo '=== BLOCKING: duplicate normalized SIRET (must return 0 rows to enforce uniqueness) ==='
SELECT regexp_replace(upper(siret), '[^0-9A-Z]', '', 'g') AS siret_norm, count(*) AS n
FROM public.fournisseurs
WHERE siret IS NOT NULL AND btrim(siret) <> ''
GROUP BY 1 HAVING count(*) > 1
ORDER BY n DESC;

\echo ''
\echo '=== BLOCKING: duplicate normalized TVA (must return 0 rows to enforce uniqueness) ==='
SELECT regexp_replace(upper(tva), '[^0-9A-Z]', '', 'g') AS tva_norm, count(*) AS n
FROM public.fournisseurs
WHERE tva IS NOT NULL AND btrim(tva) <> ''
GROUP BY 1 HAVING count(*) > 1
ORDER BY n DESC;

\echo ''
\echo '=== BLOCKING: catalogue devise absent from currencies (must return 0 rows for the FK) ==='
SELECT fc.devise, count(*) AS n
FROM public.fournisseur_catalogue fc
LEFT JOIN public.currencies c ON c.code = fc.devise
WHERE fc.devise IS NOT NULL AND fc.devise <> '' AND c.code IS NULL
GROUP BY 1 ORDER BY n DESC;

\echo ''
\echo '=== Idempotency: are #163 objects already present? (t = already applied) ==='
SELECT 'fournisseur_adresses' AS object, to_regclass('public.fournisseur_adresses') IS NOT NULL AS present
UNION ALL SELECT 'fournisseur_homologations', to_regclass('public.fournisseur_homologations') IS NOT NULL
UNION ALL SELECT 'fournisseur_catalogue_prix_history', to_regclass('public.fournisseur_catalogue_prix_history') IS NOT NULL
UNION ALL SELECT 'catalogue.incoterm', EXISTS(
  SELECT 1 FROM information_schema.columns
  WHERE table_schema='public' AND table_name='fournisseur_catalogue' AND column_name='incoterm');
