-- 20260721_commandes_fournisseurs_core.verify.sql — READ-ONLY, run AFTER apply.
-- #172 : prouve que le schéma est réellement en place ET accessible au rôle applicatif.

\echo '--- Verify #172 commandes fournisseurs ---'
SELECT current_database() AS db, now() AS at;

-- 1) Tables créées
SELECT
  to_regclass('public.commande_fournisseur')              IS NOT NULL AS has_cf,
  to_regclass('public.commande_fournisseur_ligne')        IS NOT NULL AS has_cf_ligne,
  to_regclass('public.commande_fournisseur_transition')   IS NOT NULL AS has_cf_transition,
  to_regclass('public.commande_fournisseur_document')     IS NOT NULL AS has_cf_document,
  to_regclass('public.commande_fournisseur_ligne_besoin') IS NOT NULL AS has_cf_besoin,
  to_regclass('public.commande_fournisseur_idempotence')  IS NOT NULL AS has_cf_idem;

-- 2) Contraintes clés
SELECT conname FROM pg_constraint
WHERE conname IN (
  'commande_fournisseur_code_uniq',
  'commande_fournisseur_statut_chk',
  'commande_fournisseur_origine_chk',
  'commande_fournisseur_montants_chk',
  'commande_fournisseur_ligne_position_uniq',
  'commande_fournisseur_ligne_nombres_chk',
  'commande_fournisseur_document_version_uniq',
  'commande_fournisseur_document_sha_chk',
  'cf_ligne_besoin_type_chk',
  'receptions_fournisseurs_cf_fkey',
  'reception_fournisseur_lignes_cf_ligne_fkey')
ORDER BY conname;

-- 3) Index d'unicité métier
SELECT indexname FROM pg_indexes
WHERE schemaname='public' AND indexname IN (
  'commande_fournisseur_idem_uniq',
  'cf_ligne_besoin_couverture_uniq',
  'receptions_fournisseurs_cf_idx',
  'reception_fournisseur_lignes_cf_ligne_idx')
ORDER BY indexname;

-- 4) Whitelist codification étendue (BCF accepté, scope invalide toujours refusé)
SELECT prosrc ~ 'BCF' AS whitelist_has_bcf
FROM pg_proc WHERE proname='fn_next_issued_code_value' AND pronamespace='public'::regnamespace;

DO $$
DECLARE v bigint;
BEGIN
  -- Un scope hors whitelist doit toujours lever 22023.
  BEGIN
    v := public.fn_next_issued_code_value('HACK:2026');
    RAISE EXCEPTION 'verify FAILED: rogue scope was accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    RAISE NOTICE 'ok: rogue scope still rejected (22023)';
  END;
END $$;

-- 5) Ownership + accès applicatif (42501 sentinel)
SELECT relname, pg_get_userbyid(relowner) AS owner
FROM pg_class
WHERE relname LIKE 'commande_fournisseur%' AND relkind='r'
ORDER BY relname;

SET ROLE cerp_app;
SELECT count(*) AS cf_rows            FROM public.commande_fournisseur;
SELECT count(*) AS cf_ligne_rows      FROM public.commande_fournisseur_ligne;
SELECT count(*) AS cf_transition_rows FROM public.commande_fournisseur_transition;
SELECT count(*) AS cf_document_rows   FROM public.commande_fournisseur_document;
SELECT count(*) AS cf_besoin_rows     FROM public.commande_fournisseur_ligne_besoin;
SELECT count(*) AS cf_idem_rows       FROM public.commande_fournisseur_idempotence;
RESET ROLE;

-- 6) Migration enregistrée
SELECT filename, applied_at FROM public.cerp_schema_migrations
WHERE filename = '20260721_commandes_fournisseurs_core.sql';
