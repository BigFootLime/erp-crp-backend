-- 20260729_finance_legal_mentions.preflight.sql
--
-- LECTURE SEULE. Aucune écriture, aucun DDL. À exécuter avant le patch, sur cerp_test
-- puis à nouveau avant toute décision concernant cerp_prod.
--
-- Ce que le préflight doit établir :
--   1. sur quelle base on se trouve ;
--   2. l'état réel de `factureur` — c'est de sa vacuité que vient le défaut ;
--   3. qu'aucune facture ni aucun avoir n'a été émis (sinon leur instantané est immuable
--      et l'amorçage devrait être rejoué autrement) ;
--   4. que la table de mentions n'existe pas encore, ou dans quel état elle est.

\echo '=== 0) Identité de la base ==='
SELECT current_database() AS base, current_user AS role, version() AS serveur;

\echo ''
\echo '=== 1) Colonnes réellement présentes sur public.factureur ==='
-- Attendu avant patch : aucune des colonnes légales lues par le serveur
-- (siret, siren, rcs, vat_number, capital_social) n'existe.
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'factureur'
ORDER BY ordinal_position;

\echo ''
\echo '=== 1bis) Colonnes légales attendues par le serveur : présentes ? ==='
SELECT c.expected AS colonne_attendue_par_le_code,
       (EXISTS (
          SELECT 1 FROM information_schema.columns ic
          WHERE ic.table_schema = 'public' AND ic.table_name = 'factureur'
            AND ic.column_name = c.expected
       )) AS presente
FROM (VALUES ('siret'), ('siren'), ('rcs'), ('vat_number'), ('capital_social')) AS c(expected)
ORDER BY 1;

\echo ''
\echo '=== 2) Volume de factureur (0 attendu : rien n''est configuré) ==='
SELECT count(*) AS nb_factureurs FROM public.factureur;
SELECT biller_id, biller_name, postal_code, city, country
FROM public.factureur
ORDER BY biller_name;

\echo ''
\echo '=== 3) Pièces déjà émises — un exemplaire émis est IMMUABLE ==='
-- Si l'un de ces compteurs est non nul, STOP : il faut d'abord établir quelles mentions
-- étaient en vigueur à leur date d'émission, et borner la version 1 en conséquence.
-- Aucune pièce déjà émise ne doit être régénérée.
SELECT
  (SELECT count(*) FROM public.facture)                     AS nb_factures,
  (SELECT count(*) FROM public.facture WHERE legal_number IS NOT NULL) AS nb_factures_emises,
  (SELECT count(*) FROM public.finance_billing_policies)    AS nb_politiques,
  (SELECT count(*) FROM public.finance_billing_policies WHERE active) AS nb_politiques_actives;

\echo ''
\echo '=== 3bis) Date d''émission la plus ancienne (borne basse de effective_from) ==='
SELECT min(date_emission) AS plus_ancienne_emission,
       max(date_emission) AS plus_recente_emission
FROM public.facture;

\echo ''
\echo '=== 4) État de la cible du patch ==='
SELECT
  (to_regclass('public.finance_legal_mentions') IS NOT NULL)                     AS table_mentions_existe,
  (to_regprocedure('public.fn_finance_issuer_snapshot(uuid, date)') IS NOT NULL) AS fonction_existe;

\echo ''
\echo '=== 4bis) Si la table existe déjà : versions enregistrées ==='
DO $$
DECLARE
  v_overlaps integer;
BEGIN
  IF to_regclass('public.finance_legal_mentions') IS NOT NULL THEN
    RAISE NOTICE 'finance_legal_mentions présente — contenu ci-dessous';
    EXECUTE $query$
      SELECT count(*)
      FROM public.finance_legal_mentions left_version
      JOIN public.finance_legal_mentions right_version
        ON right_version.biller_id = left_version.biller_id
       AND right_version.mention_set_id > left_version.mention_set_id
       AND daterange(left_version.effective_from, left_version.effective_to, '[)')
           && daterange(right_version.effective_from, right_version.effective_to, '[)')
    $query$ INTO v_overlaps;
    RAISE NOTICE 'Périodes de mentions qui se chevauchent : % (0 attendu)', v_overlaps;
  ELSE
    RAISE NOTICE 'finance_legal_mentions absente — création par le patch';
  END IF;
END $$;

\echo ''
\echo '=== 5) Registre des migrations ==='
SELECT filename, applied_at
FROM public.cerp_schema_migrations
WHERE filename LIKE '%legal_mentions%' OR filename LIKE '%facturation%'
ORDER BY filename;

\echo ''
\echo '=== PRÉFLIGHT TERMINÉ — aucune écriture effectuée ==='
