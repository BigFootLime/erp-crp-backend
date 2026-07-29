-- 20260729_finance_legal_mentions.sql
--
-- Mentions légales obligatoires de l'entité émettrice (code de commerce / CGI).
-- Fait suite au rendu unique des pièces financières livré par #216.
--
-- CONSTAT À L'ORIGINE DU PATCH (relevé sur cerp_test ET cerp_prod le 2026-07-29) :
--   - `public.factureur` ne porte AUCUNE colonne légale : ni SIRET, ni SIREN, ni RCS,
--     ni numéro de TVA, ni capital social, ni forme juridique. Le code serveur
--     (`ISSUER_LEGAL_FIELDS` dans facturation/services/pdf.service.ts) lisait donc des
--     colonnes qui n'existent pas : `to_jsonb(f)` ne les renvoyait jamais et le bloc
--     « Émetteur » du PDF ne portait aucune mention obligatoire.
--   - `public.factureur` est VIDE sur les deux bases (0 ligne), tout comme
--     `public.finance_billing_policies` et `public.facture`. Aucune facture n'a jamais été
--     émise par ce chemin : il n'y a donc AUCUN exemplaire immuable à préserver.
--
-- ADDITIF, IDEMPOTENT, NON DESTRUCTIF :
--   - 1 nouvelle table versionnée `finance_legal_mentions` ;
--   - 1 fonction de lecture `fn_finance_issuer_snapshot(uuid, date)` ;
--   - amorçage de l'entité émettrice CROIX ROUSSE PRECISION et de la version 1 de ses
--     mentions, en `ON CONFLICT DO NOTHING` sur un UUID fixe.
--   Aucune table existante n'est renommée, vidée, altérée ni recodée. Aucune colonne
--   n'est ajoutée à `factureur` : les mentions vivent dans la table versionnée, qui est
--   leur unique source de vérité.
--
-- POURQUOI UNE TABLE VERSIONNÉE PLUTÔT QUE DES COLONNES SUR `factureur` :
--   un taux de pénalité, un capital ou une ville de RCS changent. Une facture émise doit
--   porter les mentions **en vigueur à sa date d'émission**, et une facture déjà émise est
--   immuable. Des colonnes sur `factureur` seraient réécrites en place et falsifieraient
--   rétroactivement l'historique. Ici, une modification ouvre une nouvelle version : les
--   instantanés déjà figés continuent de résoudre la leur.
--
-- Pipeline db/patches (exécuté en tant que cerp_app). Cible : PostgreSQL 17.
--   Preflight : db/patches/support/20260729_finance_legal_mentions.preflight.sql
--   Verify    : db/patches/support/20260729_finance_legal_mentions.verify.sql
--   Rollback  : db/patches/support/20260729_finance_legal_mentions.rollback.sql

BEGIN;

/* -------------------------------------------------------------------------- */
/* 0) Pré-requis structurels                                                  */
/* -------------------------------------------------------------------------- */

DO $$
BEGIN
  IF to_regclass('public.factureur') IS NULL THEN
    RAISE EXCEPTION '#legal-mentions: public.factureur is missing — historical table, restore the base schema first';
  END IF;
END $$;

/* -------------------------------------------------------------------------- */
/* 1) Table versionnée des mentions légales                                   */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.finance_legal_mentions (
  mention_set_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  biller_id                 uuid NOT NULL REFERENCES public.factureur(biller_id),
  version                   integer NOT NULL,

  -- Période de validité. `effective_to` NULL = version en vigueur.
  effective_from            date NOT NULL,
  effective_to              date,

  -- ── Identité légale (art. R123-237 C. com.) ──────────────────────────────
  legal_form                text,           -- « SARL », « SAS »… mention obligatoire
  share_capital             numeric(14,2),  -- montant, jamais préformaté
  share_capital_currency    char(3) NOT NULL DEFAULT 'EUR',
  rcs_city                  text,           -- ville du greffe : « RCS <ville> <numéro> »
  rcs_number                text,
  siren                     text,
  siret                     text,
  vat_number                text,           -- TVA intracommunautaire
  ape_code                  text,

  -- ── Conditions de règlement ──────────────────────────────────────────────
  -- Pénalités de retard : art. L441-10 C. com. Le taux est contractuel mais ne peut
  -- être inférieur à 3× le taux d'intérêt légal ; la valeur n'est pas contrainte ici
  -- car le plancher légal change chaque semestre.
  late_penalty_rate         numeric(6,3),
  late_penalty_basis        text,           -- 'ANNUEL' | 'MENSUEL'

  -- Indemnité forfaitaire de recouvrement : art. D441-5 C. com., 40 € depuis 2013.
  recovery_indemnity        numeric(10,2) NOT NULL DEFAULT 40.00,

  -- Escompte pour paiement anticipé : mention obligatoire **même en son absence**.
  -- Taux NULL ⇒ le document doit écrire qu'aucun escompte n'est accordé.
  early_discount_rate       numeric(6,3),
  early_discount_basis      text,           -- 'ANNUEL' | 'MENSUEL'

  -- ── Régimes de TVA ───────────────────────────────────────────────────────
  vat_on_receipts           boolean NOT NULL DEFAULT false,  -- « TVA acquittée sur les encaissements »
  vat_exempt_293b           boolean NOT NULL DEFAULT false,  -- « TVA non applicable, art. 293 B du CGI »

  -- ── Clauses ──────────────────────────────────────────────────────────────
  retention_of_title        text,           -- réserve de propriété (loi du 12 mai 1980)
  extra_mentions            text[] NOT NULL DEFAULT '{}',

  created_at                timestamptz NOT NULL DEFAULT now(),
  created_by                integer,

  CONSTRAINT finance_legal_mentions_version_ck
    CHECK (version >= 1),
  CONSTRAINT finance_legal_mentions_dates_ck
    CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT finance_legal_mentions_late_penalty_ck
    CHECK (late_penalty_rate IS NULL OR late_penalty_rate > 0),
  CONSTRAINT finance_legal_mentions_late_basis_ck
    CHECK (late_penalty_basis IS NULL OR late_penalty_basis IN ('ANNUEL', 'MENSUEL')),
  CONSTRAINT finance_legal_mentions_early_basis_ck
    CHECK (early_discount_basis IS NULL OR early_discount_basis IN ('ANNUEL', 'MENSUEL')),
  CONSTRAINT finance_legal_mentions_early_pair_ck
    CHECK ((early_discount_rate IS NULL) = (early_discount_basis IS NULL)),
  CONSTRAINT finance_legal_mentions_indemnity_ck
    CHECK (recovery_indemnity >= 0),
  -- Les deux régimes s'excluent : un redevable exonéré au titre du 293 B ne peut pas
  -- acquitter la TVA sur ses encaissements.
  CONSTRAINT finance_legal_mentions_vat_regime_ck
    CHECK (NOT (vat_on_receipts AND vat_exempt_293b))
);

COMMENT ON TABLE public.finance_legal_mentions IS
  'Mentions légales de l''entité émettrice, versionnées par période de validité. Une facture fige la version en vigueur à sa date d''émission ; les versions passées ne sont jamais réécrites.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'finance_legal_mentions_biller_version_key'
  ) THEN
    ALTER TABLE public.finance_legal_mentions
      ADD CONSTRAINT finance_legal_mentions_biller_version_key UNIQUE (biller_id, version);
  END IF;
END $$;

-- Au plus une version ouverte par émetteur : sans cela, deux versions sans borne de fin
-- rendraient la résolution à une date donnée non déterministe.
CREATE UNIQUE INDEX IF NOT EXISTS finance_legal_mentions_one_open_idx
  ON public.finance_legal_mentions (biller_id)
  WHERE effective_to IS NULL;

CREATE INDEX IF NOT EXISTS finance_legal_mentions_resolution_idx
  ON public.finance_legal_mentions (biller_id, effective_from DESC);

/* -------------------------------------------------------------------------- */
/* 2) Résolution : instantané de l'émetteur à une date donnée                 */
/* -------------------------------------------------------------------------- */
-- Un seul point de vérité pour TOUS les documents sortants (facture, avoir, bon de
-- livraison, pack COFC, accusé de réception). Sans cela, chaque module reconstruirait
-- l'identité de l'émetteur à sa façon et les mentions divergeraient d'un document à
-- l'autre — c'est exactement ce que #213 et #216 ont corrigé pour la mise en page.
--
-- Les montants et taux sortent en TEXTE : le rendu ne fait aucune arithmétique flottante
-- sur une pièce fiscale, il met en forme des chaînes venues du référentiel.
-- `jsonb_strip_nulls` garantit qu'une mention absente est absente de l'instantané, et
-- non présente à NULL : le rendu n'affiche jamais de substitut à une mention manquante.

CREATE OR REPLACE FUNCTION public.fn_finance_issuer_snapshot(p_biller_id uuid, p_at date)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'biller_id',                 f.biller_id,
    'company_name',              f.biller_name,
    'address_line_1',            NULLIF(btrim(concat_ws(' ', f.house_number, f.street)), ''),
    'postal_code',               f.postal_code,
    'city',                      f.city,
    'country',                   f.country,
    'phone',                     f.phone,
    'email',                     f.email,
    'bank_name',                 f.default_bank_name,
    'iban',                      f.default_iban,
    'bic',                       f.default_bic,
    'text_on_invoice',           f.text_on_invoice,

    'legal_form',                m.legal_form,
    'share_capital',             m.share_capital::text,
    'share_capital_currency',    CASE WHEN m.share_capital IS NULL THEN NULL ELSE m.share_capital_currency END,
    'rcs_city',                  m.rcs_city,
    'rcs_number',                m.rcs_number,
    'siren',                     m.siren,
    'siret',                     m.siret,
    'vat_number',                m.vat_number,
    'ape_code',                  m.ape_code,

    'late_penalty_rate',         m.late_penalty_rate::text,
    'late_penalty_basis',        m.late_penalty_basis,
    'recovery_indemnity',        CASE WHEN m.mention_set_id IS NULL THEN NULL ELSE m.recovery_indemnity::text END,
    'early_discount_rate',       m.early_discount_rate::text,
    'early_discount_basis',      m.early_discount_basis,

    -- Booléens : seul `true` est porté. `false` disparaît avec strip_nulls, ce qui est
    -- le comportement voulu — un régime non applicable n'est pas une mention.
    'vat_on_receipts',           CASE WHEN m.vat_on_receipts   THEN true ELSE NULL END,
    'vat_exempt_293b',           CASE WHEN m.vat_exempt_293b   THEN true ELSE NULL END,

    'retention_of_title',        m.retention_of_title,
    'extra_mentions',            CASE WHEN m.extra_mentions IS NULL OR cardinality(m.extra_mentions) = 0
                                      THEN NULL ELSE to_jsonb(m.extra_mentions) END,

    -- Traçabilité de la version figée : c'est ce qui permet de prouver, des années plus
    -- tard, quelles mentions étaient applicables au moment de l'émission.
    'legal_mentions_version',        m.version,
    'legal_mentions_effective_from', m.effective_from::text
  ))
  FROM public.factureur f
  LEFT JOIN public.finance_legal_mentions m
         ON m.biller_id = f.biller_id
        AND m.effective_from <= p_at
        AND (m.effective_to IS NULL OR m.effective_to > p_at)
  WHERE f.biller_id = p_biller_id;
$$;

COMMENT ON FUNCTION public.fn_finance_issuer_snapshot(uuid, date) IS
  'Instantané complet de l''entité émettrice à une date donnée : identité opérationnelle (factureur) + mentions légales en vigueur (finance_legal_mentions). Destiné à être figé tel quel dans issuer_snapshot.';

/* -------------------------------------------------------------------------- */
/* 3) Amorçage de l'entité émettrice                                          */
/* -------------------------------------------------------------------------- */
-- `factureur` est vide sur les deux bases : sans cette ligne, `getIssuerParty()` renvoie
-- {} (bloc « Émetteur » vide) et `issuerSnapshot()` lève 503 FINANCE_ISSUER_NOT_CONFIGURED
-- à la première émission. L'UUID est fixe pour rendre l'amorçage rejouable.
--
-- Sources des valeurs :
--   - annuaire-entreprises.data.gouv.fr / registre national des entreprises (INPI),
--     SIREN 380569012, consulté le 2026-07-29 : dénomination, forme juridique
--     (catégorie INSEE 5499 = SARL), capital 21 000,00 € fixe, TVA FR73 380 569 012,
--     siège 530 rue de la Dombes, Les Échets, 01700 MIRIBEL, immatriculation 28/01/1991 ;
--   - facture papier CERP n° 5256 du 24/07/2026 : taux de pénalité, taux d'escompte,
--     clause de réserve de propriété, régime de TVA, coordonnées bancaires, téléphone.
--
-- Ville du RCS : Miribel est dans l'Ain (01), dont le ressort unique est le greffe du
-- tribunal de commerce de Bourg-en-Bresse. La facture papier n'imprimait que le numéro,
-- sans ville — la mention était donc incomplète au regard de l'art. R123-237.

INSERT INTO public.factureur (
  biller_id, biller_name, street, house_number, postal_code, city, country,
  phone, default_bank_name, default_iban, default_bic
)
VALUES (
  'b7c1e5a2-3f4d-4e8b-9a06-380569012000'::uuid,
  'CROIX ROUSSE PRECISION',
  'Rue de la Dombes',
  '530',
  '01700',
  'MIRIBEL LES ECHETS',
  'France',
  '04 72 00 26 25',
  'SG LYON CROIX-ROUSSE',
  'FR76 3000 3024 9100 0200 0775 958',
  'SOGEFRPP'
)
ON CONFLICT (biller_id) DO NOTHING;

/* -------------------------------------------------------------------------- */
/* 4) Version 1 des mentions légales                                          */
/* -------------------------------------------------------------------------- */
-- `effective_from` au 1er janvier 2026 : ces mentions sont celles que l'entreprise
-- imprime aujourd'hui, et l'exercice en cours est la période la plus large que l'on
-- puisse couvrir sans affirmer ce qui était en vigueur les années précédentes. Aucune
-- facture n'existant en base, aucune pièce ne se retrouve hors période.
--
-- L'indemnité forfaitaire de 40 € est ajoutée ici alors qu'elle ne figurait PAS sur la
-- facture papier : elle est obligatoire depuis le décret 2012-1115 (art. D441-5 C. com.)
-- et son absence est sanctionnable. Ce n'est pas un choix de paramétrage.

INSERT INTO public.finance_legal_mentions (
  biller_id, version, effective_from, effective_to,
  legal_form, share_capital, share_capital_currency,
  rcs_city, rcs_number, siren, siret, vat_number,
  late_penalty_rate, late_penalty_basis,
  recovery_indemnity,
  early_discount_rate, early_discount_basis,
  vat_on_receipts, vat_exempt_293b,
  retention_of_title
)
VALUES (
  'b7c1e5a2-3f4d-4e8b-9a06-380569012000'::uuid,
  1,
  DATE '2026-01-01',
  NULL,
  'SARL',
  21000.00,
  'EUR',
  'Bourg-en-Bresse',
  '380 569 012',
  '380 569 012',
  '380 569 012 00020',
  'FR73 380 569 012',
  12.500,
  'ANNUEL',
  40.00,
  1.500,
  'MENSUEL',
  true,
  false,
  'Nous nous réservons la propriété des marchandises jusqu''au paiement intégral du prix par l''acheteur. Notre droit de revendication porte aussi bien sur les marchandises que sur leur prix si elles ont déjà été revendues (loi du 12 mai 1980).'
)
ON CONFLICT (biller_id, version) DO NOTHING;

/* -------------------------------------------------------------------------- */
/* 5) Accès applicatif                                                        */
/* -------------------------------------------------------------------------- */
-- Le patch peut être appliqué par le rôle administratif `postgres` via psql (peer auth).
-- Sans cette reprise d'ownership, `cerp_app` reçoit « permission denied for table … »
-- (SQLSTATE 42501) et l'API répond 500 alors que le schéma est correct — régression
-- constatée en production le 2026-07-21, cf. db/privileged/20260721_fix_app_table_ownership.sql.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    EXECUTE 'ALTER TABLE public.finance_legal_mentions OWNER TO cerp_app';
    EXECUTE 'ALTER FUNCTION public.fn_finance_issuer_snapshot(uuid, date) OWNER TO cerp_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON public.finance_legal_mentions TO cerp_app';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.fn_finance_issuer_snapshot(uuid, date) TO cerp_app';
  END IF;
END $$;

COMMIT;
