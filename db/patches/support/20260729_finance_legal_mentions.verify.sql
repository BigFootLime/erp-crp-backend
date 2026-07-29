-- 20260729_finance_legal_mentions.verify.sql
--
-- Vérification après application. Échoue bruyamment : une mention obligatoire absente
-- d'une facture est sanctionnable, elle ne doit pas passer une vérification silencieuse.

\echo '=== Base vérifiée ==='
SELECT current_database() AS base;

/* -------------------------------------------------------------------------- */
/* 1) Structure                                                               */
/* -------------------------------------------------------------------------- */

DO $$
BEGIN
  IF to_regclass('public.finance_legal_mentions') IS NULL THEN
    RAISE EXCEPTION 'VERIFY: public.finance_legal_mentions est absente';
  END IF;
  IF to_regprocedure('public.fn_finance_issuer_snapshot(uuid, date)') IS NULL THEN
    RAISE EXCEPTION 'VERIFY: public.fn_finance_issuer_snapshot(uuid, date) est absente';
  END IF;
  IF to_regprocedure('public.tg_finance_legal_mentions_no_overlap()') IS NULL THEN
    RAISE EXCEPTION 'VERIFY: fonction de garde anti-chevauchement absente — appliquer le hardening #221';
  END IF;
END $$;

\echo ''
\echo '=== 1) Contraintes attendues ==='
SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'public.finance_legal_mentions'::regclass
ORDER BY conname;

DO $$
DECLARE
  v_missing text;
BEGIN
  FOR v_missing IN
    SELECT c.expected
    FROM (VALUES
      ('finance_legal_mentions_version_ck'),
      ('finance_legal_mentions_dates_ck'),
      ('finance_legal_mentions_late_penalty_ck'),
      ('finance_legal_mentions_late_basis_ck'),
      ('finance_legal_mentions_early_basis_ck'),
      ('finance_legal_mentions_early_pair_ck'),
      ('finance_legal_mentions_indemnity_ck'),
      ('finance_legal_mentions_vat_regime_ck'),
      ('finance_legal_mentions_biller_version_key')
    ) AS c(expected)
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'public.finance_legal_mentions'::regclass AND conname = c.expected
    )
  LOOP
    RAISE EXCEPTION 'VERIFY: contrainte manquante %', v_missing;
  END LOOP;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'finance_legal_mentions_one_open_idx'
  ) THEN
    RAISE EXCEPTION 'VERIFY: index unique partiel finance_legal_mentions_one_open_idx manquant — deux versions ouvertes rendraient la résolution non déterministe';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'finance_legal_mentions_effective_from_uidx'
  ) THEN
    RAISE EXCEPTION 'VERIFY: index unique finance_legal_mentions_effective_from_uidx manquant';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgrelid = 'public.finance_legal_mentions'::regclass
      AND tgname = 'finance_legal_mentions_no_overlap_trg'
      AND NOT tgisinternal
      AND tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'VERIFY: trigger anti-chevauchement manquant ou désactivé';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.finance_legal_mentions left_version
    JOIN public.finance_legal_mentions right_version
      ON right_version.biller_id = left_version.biller_id
     AND right_version.mention_set_id > left_version.mention_set_id
     AND daterange(left_version.effective_from, left_version.effective_to, '[)')
         && daterange(right_version.effective_from, right_version.effective_to, '[)')
  ) THEN
    RAISE EXCEPTION 'VERIFY: périodes de mentions qui se chevauchent';
  END IF;
END $$;

/* -------------------------------------------------------------------------- */
/* 2) Amorçage                                                                */
/* -------------------------------------------------------------------------- */

\echo ''
\echo '=== 2) Entité émettrice ==='
SELECT biller_id, biller_name, house_number, street, postal_code, city, country, phone
FROM public.factureur
ORDER BY biller_name;

DO $$
DECLARE
  v_nb integer;
BEGIN
  SELECT count(*) INTO v_nb FROM public.factureur;
  IF v_nb = 0 THEN
    RAISE EXCEPTION 'VERIFY: aucune entité émettrice — le bloc « Émetteur » des documents resterait vide';
  END IF;
END $$;

\echo ''
\echo '=== 3) Versions de mentions ==='
SELECT version, effective_from, effective_to, legal_form, share_capital,
       rcs_city, rcs_number, siret, vat_number,
       late_penalty_rate, late_penalty_basis, recovery_indemnity,
       early_discount_rate, early_discount_basis,
       vat_on_receipts, vat_exempt_293b
FROM public.finance_legal_mentions
ORDER BY biller_id, version;

DO $$
DECLARE
  v_open integer;
BEGIN
  SELECT count(*) INTO v_open
  FROM public.finance_legal_mentions WHERE effective_to IS NULL;
  IF v_open <> 1 THEN
    RAISE EXCEPTION 'VERIFY: % version(s) en vigueur, 1 attendue', v_open;
  END IF;
END $$;

/* -------------------------------------------------------------------------- */
/* 3) Les cinq mentions obligatoires du ticket sont résolues                  */
/* -------------------------------------------------------------------------- */

\echo ''
\echo '=== 4) Instantané résolu au 2026-07-29 ==='
SELECT jsonb_pretty(public.fn_finance_issuer_snapshot(
  (SELECT biller_id FROM public.factureur ORDER BY biller_name LIMIT 1),
  DATE '2026-07-29'
)) AS instantane;

DO $$
DECLARE
  v_snap    jsonb;
  v_biller  uuid;
  v_missing text;
BEGIN
  SELECT biller_id INTO v_biller FROM public.factureur ORDER BY biller_name LIMIT 1;
  v_snap := public.fn_finance_issuer_snapshot(v_biller, DATE '2026-07-29');

  IF v_snap IS NULL THEN
    RAISE EXCEPTION 'VERIFY: la fonction ne résout aucun instantané pour %', v_biller;
  END IF;

  -- 1. Pénalités de retard — art. L441-10 C. com.
  -- 2. Indemnité forfaitaire de recouvrement — art. D441-5 C. com.
  -- 3. Escompte (taux, ou absence explicite côté rendu)
  -- 4. Identité : RCS + ville, capital social, forme juridique
  FOR v_missing IN
    SELECT k.key
    FROM (VALUES
      ('late_penalty_rate'), ('late_penalty_basis'),
      ('recovery_indemnity'),
      ('legal_form'), ('share_capital'), ('share_capital_currency'),
      ('rcs_city'), ('rcs_number'),
      ('siren'), ('siret'), ('vat_number'),
      ('company_name'), ('legal_mentions_version')
    ) AS k(key)
    WHERE NOT (v_snap ? k.key)
  LOOP
    RAISE EXCEPTION 'VERIFY: mention obligatoire absente de l''instantané : %', v_missing;
  END LOOP;

  -- L'indemnité forfaitaire est de 40 € par facture impayée (montant fixé par décret).
  IF (v_snap ->> 'recovery_indemnity')::numeric <> 40.00 THEN
    RAISE EXCEPTION 'VERIFY: indemnité forfaitaire = % €, 40.00 attendus (art. D441-5)',
      v_snap ->> 'recovery_indemnity';
  END IF;

  -- Un instantané ne doit jamais porter d'identifiant technique client ni de clé nulle.
  IF v_snap ? 'client_id' THEN
    RAISE EXCEPTION 'VERIFY: l''instantané émetteur porte un client_id';
  END IF;

  RAISE NOTICE 'VERIFY: instantané complet — version % en vigueur depuis %',
    v_snap ->> 'legal_mentions_version', v_snap ->> 'legal_mentions_effective_from';
END $$;

/* -------------------------------------------------------------------------- */
/* 4) Le versionnement fait bien son travail                                  */
/* -------------------------------------------------------------------------- */
-- Une date antérieure à la première version doit rendre l'identité opérationnelle SANS
-- mentions : le rendu affichera alors ce qu'il a, et rien d'inventé. C'est le
-- comportement voulu, et c'est ce qui protège l'historique d'une réécriture.

DO $$
DECLARE
  v_snap   jsonb;
  v_biller uuid;
BEGIN
  SELECT biller_id INTO v_biller FROM public.factureur ORDER BY biller_name LIMIT 1;
  v_snap := public.fn_finance_issuer_snapshot(v_biller, DATE '2020-01-01');

  IF v_snap ? 'late_penalty_rate' THEN
    RAISE EXCEPTION 'VERIFY: des mentions sont résolues hors de leur période de validité';
  END IF;
  IF NOT (v_snap ? 'company_name') THEN
    RAISE EXCEPTION 'VERIFY: identité opérationnelle perdue hors période de mentions';
  END IF;

  RAISE NOTICE 'VERIFY: résolution hors période correcte — identité sans mentions';
END $$;

/* -------------------------------------------------------------------------- */
/* 5) Accès applicatif                                                        */
/* -------------------------------------------------------------------------- */

\echo ''
\echo '=== 5) Ownership et privilèges runtime ==='
SELECT tablename, tableowner
FROM pg_tables
WHERE schemaname = 'public' AND tablename = 'finance_legal_mentions';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    IF NOT has_table_privilege('cerp_app', 'public.finance_legal_mentions', 'SELECT') THEN
      RAISE EXCEPTION 'VERIFY: cerp_app ne peut pas lire finance_legal_mentions (SQLSTATE 42501 en runtime → API 500)';
    END IF;
    IF NOT has_function_privilege('cerp_app', 'public.fn_finance_issuer_snapshot(uuid, date)', 'EXECUTE') THEN
      RAISE EXCEPTION 'VERIFY: cerp_app ne peut pas exécuter fn_finance_issuer_snapshot';
    END IF;
    RAISE NOTICE 'VERIFY: accès runtime cerp_app confirmé';
  ELSE
    RAISE NOTICE 'VERIFY: rôle cerp_app absent de cette base — contrôle d''accès ignoré';
  END IF;
END $$;

\echo ''
\echo '=== VERIFY TERMINÉ SANS ERREUR ==='
