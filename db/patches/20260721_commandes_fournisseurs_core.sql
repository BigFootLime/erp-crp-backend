-- 20260721_commandes_fournisseurs_core.sql
-- Issue #172 — Commandes fournisseurs (bounded context absent, créé from scratch).
-- Additive, idempotent, non-destructive. Safe to run multiple times.
--
-- Creates the supplier purchase-order aggregate:
--   * commande_fournisseur            (header, BCF-AAAA-NNNN server code, 9-state machine)
--   * commande_fournisseur_ligne      (ordered lines, typed, quality requirements)
--   * commande_fournisseur_transition (append-only state history)
--   * commande_fournisseur_document   (frozen document versions, canonical JSON + SHA-256)
--   * commande_fournisseur_ligne_besoin (immutable need->line coverage links, anti double-order)
--   * commande_fournisseur_idempotence  (idempotency keys for create/generate/send replay)
-- Extends (additive, nullable — NO second reception subsystem, cf. #172 contract):
--   * receptions_fournisseurs.commande_fournisseur_id
--   * reception_fournisseur_lignes.commande_fournisseur_ligne_id
-- Extends the central business-code allocator whitelist with the BCF scope
-- (fn_next_issued_code_value — body identical to 20260713, only the regex gains BCF).
--
-- SOURCE OF TRUTH (unchanged): public.fournisseurs (UUID) canonical supplier master;
-- public.fournisseur_catalogue price/lead-time source; public.receptions_fournisseurs
-- stays the ONLY reception subsystem. Quantities received are NEVER duplicated on the
-- order lines: they are computed server-side by SUM over linked reception lines.
--
-- No DROP/DELETE/UPDATE of existing data. ADD COLUMN ... nullable => metadata-only.
-- Support scripts (run manually, NOT picked up by db:patches:up):
--   db/patches/support/20260721_commandes_fournisseurs_core.preflight.sql (read-only, BEFORE)
--   db/patches/support/20260721_commandes_fournisseurs_core.verify.sql    (read-only, AFTER)
--   db/patches/support/20260721_commandes_fournisseurs_core.rollback.sql  (guarded, non-destructive)

BEGIN;

/* -------------------------------------------------------------------------- */
/* 0) Guards: upstream canonical tables must already exist                     */
/* -------------------------------------------------------------------------- */

DO $$
BEGIN
  IF to_regclass('public.fournisseurs') IS NULL THEN
    RAISE EXCEPTION '#172: public.fournisseurs is missing — apply the fournisseurs patches first';
  END IF;
  IF to_regclass('public.articles') IS NULL THEN
    RAISE EXCEPTION '#172: public.articles is missing';
  END IF;
  IF to_regclass('public.receptions_fournisseurs') IS NULL THEN
    RAISE EXCEPTION '#172: public.receptions_fournisseurs is missing — reception subsystem is a hard dependency';
  END IF;
  IF to_regprocedure('public.fn_next_issued_code_value(text)') IS NULL THEN
    RAISE EXCEPTION '#172: public.fn_next_issued_code_value(text) is missing — apply 20260713_codification_versions_of_vsm.sql first';
  END IF;
END $$;

/* -------------------------------------------------------------------------- */
/* 1) Codification: add the BCF scope to the whitelisted allocator             */
/*    Body identical to 20260713 — ONLY the regex gains |BCF (additive).       */
/* -------------------------------------------------------------------------- */

CREATE OR REPLACE FUNCTION public.fn_next_issued_code_value(p_scope text)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  v_scope text := upper(btrim(COALESCE(p_scope, '')));
BEGIN
  IF v_scope !~ '^(CLI|FOU|ART:[A-Z0-9]{1,48}|(DEV|CMD|AFF|OF|LOT|MVT|CQ|NC|CAPA|BL|FACT|BCF):[0-9]{4})$' THEN
    RAISE EXCEPTION 'Unsupported business-code sequence scope: %', p_scope
      USING ERRCODE = '22023';
  END IF;
  RETURN nextval('public.cerp_business_code_issue_seq'::regclass);
END;
$$;

COMMENT ON FUNCTION public.fn_next_issued_code_value(text) IS
  'Whitelisted, non-reusable business-code allocator backed by a native PostgreSQL sequence. #172 adds the BCF scope (bons de commande fournisseurs).';

/* -------------------------------------------------------------------------- */
/* 2) Header: commande_fournisseur                                             */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.commande_fournisseur (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                     text NOT NULL,
  statut                   text NOT NULL DEFAULT 'BROUILLON',
  origine                  text NOT NULL DEFAULT 'MANUEL',
  fournisseur_id           uuid NOT NULL,
  contact_id               uuid,
  adresse_commande_id      uuid,
  magasin_livraison_id     uuid,
  adresse_livraison_texte  text,
  adresse_facturation_texte text,
  devise                   text NOT NULL DEFAULT 'EUR',
  conditions_paiement      text,
  incoterm                 text,
  mode_transport           text,
  date_besoin              date,
  date_promesse            date,
  date_envoi               timestamptz,
  date_accuse              timestamptz,
  date_cloture             timestamptz,
  date_annulation          timestamptz,
  reference_fournisseur    text,
  commentaire_public       text,
  note_interne             text,
  motif_revision           text,
  motif_annulation         text,
  motif_cloture            text,
  version_document         integer NOT NULL DEFAULT 0,
  fournisseur_snapshot     jsonb,
  conditions_snapshot      jsonb,
  total_ht                 numeric(14,2) NOT NULL DEFAULT 0,
  total_remise             numeric(14,2) NOT NULL DEFAULT 0,
  total_tva                numeric(14,2) NOT NULL DEFAULT 0,
  frais_port_ht            numeric(12,2) NOT NULL DEFAULT 0,
  tva_frais_pct            numeric(5,2)  NOT NULL DEFAULT 20,
  total_ttc                numeric(14,2) NOT NULL DEFAULT 0,
  idempotency_key          text,
  submitted_at             timestamptz,
  submitted_by             integer,
  approved_at              timestamptz,
  approved_by              integer,
  sent_by                  integer,
  acknowledged_by          integer,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  created_by               integer,
  updated_by               integer
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commande_fournisseur_code_uniq') THEN
    ALTER TABLE public.commande_fournisseur
      ADD CONSTRAINT commande_fournisseur_code_uniq UNIQUE (code);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commande_fournisseur_statut_chk') THEN
    ALTER TABLE public.commande_fournisseur
      ADD CONSTRAINT commande_fournisseur_statut_chk CHECK (statut = ANY (ARRAY[
        'BROUILLON','A_VALIDER','APPROUVEE','ENVOYEE','ACCUSE_RECU',
        'PARTIELLEMENT_RECUE','RECUE','CLOTUREE','ANNULEE']));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commande_fournisseur_origine_chk') THEN
    ALTER TABLE public.commande_fournisseur
      ADD CONSTRAINT commande_fournisseur_origine_chk CHECK (origine = ANY (ARRAY[
        'MANUEL','SEUIL_STOCK','RUPTURE_OF','PROPOSITION_MRP','SOUS_TRAITANCE','AUTRE']));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commande_fournisseur_incoterm_chk') THEN
    ALTER TABLE public.commande_fournisseur
      ADD CONSTRAINT commande_fournisseur_incoterm_chk CHECK (incoterm IS NULL OR incoterm = ANY (ARRAY[
        'EXW','FCA','FAS','FOB','CFR','CIF','CPT','CIP','DAP','DPU','DDP']));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commande_fournisseur_montants_chk') THEN
    ALTER TABLE public.commande_fournisseur
      ADD CONSTRAINT commande_fournisseur_montants_chk CHECK (
        total_ht >= 0 AND total_remise >= 0 AND total_tva >= 0 AND total_ttc >= 0
        AND frais_port_ht >= 0 AND tva_frais_pct >= 0 AND tva_frais_pct <= 100
        AND version_document >= 0);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commande_fournisseur_fournisseur_fkey') THEN
    ALTER TABLE public.commande_fournisseur
      ADD CONSTRAINT commande_fournisseur_fournisseur_fkey
      FOREIGN KEY (fournisseur_id) REFERENCES public.fournisseurs(id) ON DELETE RESTRICT;
  END IF;

  IF to_regclass('public.fournisseur_contacts') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commande_fournisseur_contact_fkey') THEN
    ALTER TABLE public.commande_fournisseur
      ADD CONSTRAINT commande_fournisseur_contact_fkey
      FOREIGN KEY (contact_id) REFERENCES public.fournisseur_contacts(id) ON DELETE SET NULL;
  END IF;

  IF to_regclass('public.fournisseur_adresses') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commande_fournisseur_adresse_cmd_fkey') THEN
    ALTER TABLE public.commande_fournisseur
      ADD CONSTRAINT commande_fournisseur_adresse_cmd_fkey
      FOREIGN KEY (adresse_commande_id) REFERENCES public.fournisseur_adresses(id) ON DELETE SET NULL;
  END IF;

  IF to_regclass('public.magasins') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commande_fournisseur_magasin_fkey') THEN
    ALTER TABLE public.commande_fournisseur
      ADD CONSTRAINT commande_fournisseur_magasin_fkey
      FOREIGN KEY (magasin_livraison_id) REFERENCES public.magasins(id) ON DELETE SET NULL;
  END IF;

  IF to_regclass('public.currencies') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commande_fournisseur_devise_fkey') THEN
    ALTER TABLE public.commande_fournisseur
      ADD CONSTRAINT commande_fournisseur_devise_fkey
      FOREIGN KEY (devise) REFERENCES public.currencies(code) ON DELETE RESTRICT;
  END IF;

  IF to_regclass('public.users') IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commande_fournisseur_created_by_fkey') THEN
      ALTER TABLE public.commande_fournisseur
        ADD CONSTRAINT commande_fournisseur_created_by_fkey
        FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commande_fournisseur_updated_by_fkey') THEN
      ALTER TABLE public.commande_fournisseur
        ADD CONSTRAINT commande_fournisseur_updated_by_fkey
        FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commande_fournisseur_submitted_by_fkey') THEN
      ALTER TABLE public.commande_fournisseur
        ADD CONSTRAINT commande_fournisseur_submitted_by_fkey
        FOREIGN KEY (submitted_by) REFERENCES public.users(id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commande_fournisseur_approved_by_fkey') THEN
      ALTER TABLE public.commande_fournisseur
        ADD CONSTRAINT commande_fournisseur_approved_by_fkey
        FOREIGN KEY (approved_by) REFERENCES public.users(id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commande_fournisseur_sent_by_fkey') THEN
      ALTER TABLE public.commande_fournisseur
        ADD CONSTRAINT commande_fournisseur_sent_by_fkey
        FOREIGN KEY (sent_by) REFERENCES public.users(id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commande_fournisseur_ack_by_fkey') THEN
      ALTER TABLE public.commande_fournisseur
        ADD CONSTRAINT commande_fournisseur_ack_by_fkey
        FOREIGN KEY (acknowledged_by) REFERENCES public.users(id) ON DELETE SET NULL;
    END IF;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS commande_fournisseur_statut_idx      ON public.commande_fournisseur (statut);
CREATE INDEX IF NOT EXISTS commande_fournisseur_fournisseur_idx ON public.commande_fournisseur (fournisseur_id);
CREATE INDEX IF NOT EXISTS commande_fournisseur_origine_idx     ON public.commande_fournisseur (origine);
CREATE INDEX IF NOT EXISTS commande_fournisseur_date_besoin_idx ON public.commande_fournisseur (date_besoin);
CREATE INDEX IF NOT EXISTS commande_fournisseur_updated_at_idx  ON public.commande_fournisseur (updated_at);
CREATE INDEX IF NOT EXISTS commande_fournisseur_created_at_idx  ON public.commande_fournisseur (created_at);
-- Idempotent creation replay: at most one order per idempotency key.
CREATE UNIQUE INDEX IF NOT EXISTS commande_fournisseur_idem_uniq
  ON public.commande_fournisseur (idempotency_key) WHERE idempotency_key IS NOT NULL;

COMMENT ON TABLE public.commande_fournisseur IS
  '#172 : en-tête de commande fournisseur (BCF). Code visible immuable généré serveur (BCF-AAAA-NNNN). Jamais supprimée : ANNULEE/CLOTUREE + archivage.';
COMMENT ON COLUMN public.commande_fournisseur.fournisseur_snapshot IS
  '#172 : snapshot fournisseur/contact/adresses figé à l''envoi — une modification ultérieure de la fiche fournisseur ne réécrit pas l''historique.';
COMMENT ON COLUMN public.commande_fournisseur.version_document IS
  '#172 : nombre de versions documentaires figées ; l''envoi exige version_document >= 1.';

/* -------------------------------------------------------------------------- */
/* 3) Lines: commande_fournisseur_ligne                                        */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.commande_fournisseur_ligne (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  commande_id            uuid NOT NULL,
  position               integer NOT NULL DEFAULT 1,
  type                   text NOT NULL DEFAULT 'ARTICLE',
  article_id             uuid,
  catalogue_id           uuid,
  reference_fournisseur  text,
  designation            text NOT NULL,
  designation_interne    text,
  unite                  text,
  unite_stock            text,
  coef_conversion        numeric(12,6),
  quantite               numeric(14,3) NOT NULL,
  prix_unitaire_ht       numeric(14,4) NOT NULL DEFAULT 0,
  remise_pct             numeric(5,2)  NOT NULL DEFAULT 0,
  tva_pct                numeric(5,2)  NOT NULL DEFAULT 20,
  frais_ht               numeric(12,2) NOT NULL DEFAULT 0,
  date_besoin            date,
  date_promesse          date,
  delai_jours            integer,
  affaire_id             bigint,
  commande_client_id     bigint,
  of_id                  bigint,
  piece_technique_id     uuid,
  operation_libelle      text,
  magasin_id             uuid,
  exigences_qualite      jsonb NOT NULL DEFAULT '[]'::jsonb,
  documents_attendus     text[] NOT NULL DEFAULT '{}',
  qty_confirmee          numeric(14,3),
  qty_annulee            numeric(14,3) NOT NULL DEFAULT 0,
  statut_ligne           text NOT NULL DEFAULT 'ACTIVE',
  motif_annulation       text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  created_by             integer,
  updated_by             integer
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commande_fournisseur_ligne_commande_fkey') THEN
    ALTER TABLE public.commande_fournisseur_ligne
      ADD CONSTRAINT commande_fournisseur_ligne_commande_fkey
      FOREIGN KEY (commande_id) REFERENCES public.commande_fournisseur(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commande_fournisseur_ligne_type_chk') THEN
    ALTER TABLE public.commande_fournisseur_ligne
      ADD CONSTRAINT commande_fournisseur_ligne_type_chk CHECK (type = ANY (ARRAY[
        'ARTICLE','MATIERE','COMPOSANT','SOUS_TRAITANCE','PRESTATION','LIBRE_CONTROLEE']));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commande_fournisseur_ligne_statut_chk') THEN
    ALTER TABLE public.commande_fournisseur_ligne
      ADD CONSTRAINT commande_fournisseur_ligne_statut_chk CHECK (statut_ligne = ANY (ARRAY['ACTIVE','ANNULEE']));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commande_fournisseur_ligne_nombres_chk') THEN
    ALTER TABLE public.commande_fournisseur_ligne
      ADD CONSTRAINT commande_fournisseur_ligne_nombres_chk CHECK (
        quantite > 0
        AND prix_unitaire_ht >= 0
        AND remise_pct >= 0 AND remise_pct <= 100
        AND tva_pct >= 0 AND tva_pct <= 100
        AND frais_ht >= 0
        AND (coef_conversion IS NULL OR coef_conversion > 0)
        AND (delai_jours IS NULL OR delai_jours >= 0)
        AND (qty_confirmee IS NULL OR qty_confirmee >= 0)
        AND qty_annulee >= 0 AND qty_annulee <= quantite
        AND position >= 1);
  END IF;

  -- Stable, reorderable position (deferred so transactional swaps never trip it).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commande_fournisseur_ligne_position_uniq') THEN
    ALTER TABLE public.commande_fournisseur_ligne
      ADD CONSTRAINT commande_fournisseur_ligne_position_uniq
      UNIQUE (commande_id, position) DEFERRABLE INITIALLY DEFERRED;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commande_fournisseur_ligne_article_fkey') THEN
    ALTER TABLE public.commande_fournisseur_ligne
      ADD CONSTRAINT commande_fournisseur_ligne_article_fkey
      FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE RESTRICT;
  END IF;

  IF to_regclass('public.fournisseur_catalogue') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commande_fournisseur_ligne_catalogue_fkey') THEN
    ALTER TABLE public.commande_fournisseur_ligne
      ADD CONSTRAINT commande_fournisseur_ligne_catalogue_fkey
      FOREIGN KEY (catalogue_id) REFERENCES public.fournisseur_catalogue(id) ON DELETE SET NULL;
  END IF;

  IF to_regclass('public.affaire') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commande_fournisseur_ligne_affaire_fkey') THEN
    ALTER TABLE public.commande_fournisseur_ligne
      ADD CONSTRAINT commande_fournisseur_ligne_affaire_fkey
      FOREIGN KEY (affaire_id) REFERENCES public.affaire(id) ON DELETE SET NULL;
  END IF;

  IF to_regclass('public.commande_client') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commande_fournisseur_ligne_cc_fkey') THEN
    ALTER TABLE public.commande_fournisseur_ligne
      ADD CONSTRAINT commande_fournisseur_ligne_cc_fkey
      FOREIGN KEY (commande_client_id) REFERENCES public.commande_client(id) ON DELETE SET NULL;
  END IF;

  IF to_regclass('public.ordres_fabrication') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commande_fournisseur_ligne_of_fkey') THEN
    ALTER TABLE public.commande_fournisseur_ligne
      ADD CONSTRAINT commande_fournisseur_ligne_of_fkey
      FOREIGN KEY (of_id) REFERENCES public.ordres_fabrication(id) ON DELETE SET NULL;
  END IF;

  IF to_regclass('public.pieces_techniques') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commande_fournisseur_ligne_pt_fkey') THEN
    ALTER TABLE public.commande_fournisseur_ligne
      ADD CONSTRAINT commande_fournisseur_ligne_pt_fkey
      FOREIGN KEY (piece_technique_id) REFERENCES public.pieces_techniques(id) ON DELETE SET NULL;
  END IF;

  IF to_regclass('public.magasins') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commande_fournisseur_ligne_magasin_fkey') THEN
    ALTER TABLE public.commande_fournisseur_ligne
      ADD CONSTRAINT commande_fournisseur_ligne_magasin_fkey
      FOREIGN KEY (magasin_id) REFERENCES public.magasins(id) ON DELETE SET NULL;
  END IF;

  IF to_regclass('public.users') IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commande_fournisseur_ligne_created_by_fkey') THEN
      ALTER TABLE public.commande_fournisseur_ligne
        ADD CONSTRAINT commande_fournisseur_ligne_created_by_fkey
        FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commande_fournisseur_ligne_updated_by_fkey') THEN
      ALTER TABLE public.commande_fournisseur_ligne
        ADD CONSTRAINT commande_fournisseur_ligne_updated_by_fkey
        FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;
    END IF;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS commande_fournisseur_ligne_commande_idx ON public.commande_fournisseur_ligne (commande_id);
CREATE INDEX IF NOT EXISTS commande_fournisseur_ligne_article_idx  ON public.commande_fournisseur_ligne (article_id);
CREATE INDEX IF NOT EXISTS commande_fournisseur_ligne_of_idx       ON public.commande_fournisseur_ligne (of_id);
CREATE INDEX IF NOT EXISTS commande_fournisseur_ligne_affaire_idx  ON public.commande_fournisseur_ligne (affaire_id);

COMMENT ON TABLE public.commande_fournisseur_ligne IS
  '#172 : ligne de commande fournisseur. Quantités reçues JAMAIS stockées ici : calculées par SUM sur reception_fournisseur_lignes.commande_fournisseur_ligne_id (une seule vérité).';

/* -------------------------------------------------------------------------- */
/* 4) Append-only state history: commande_fournisseur_transition               */
/*    ON DELETE RESTRICT: la traçabilité bloque toute suppression d'en-tête.   */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.commande_fournisseur_transition (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  commande_id  uuid NOT NULL,
  from_statut  text,
  to_statut    text NOT NULL,
  motif        text,
  acteur_id    integer,
  created_at   timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commande_fournisseur_transition_commande_fkey') THEN
    ALTER TABLE public.commande_fournisseur_transition
      ADD CONSTRAINT commande_fournisseur_transition_commande_fkey
      FOREIGN KEY (commande_id) REFERENCES public.commande_fournisseur(id) ON DELETE RESTRICT;
  END IF;
  IF to_regclass('public.users') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commande_fournisseur_transition_acteur_fkey') THEN
    ALTER TABLE public.commande_fournisseur_transition
      ADD CONSTRAINT commande_fournisseur_transition_acteur_fkey
      FOREIGN KEY (acteur_id) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS commande_fournisseur_transition_commande_idx
  ON public.commande_fournisseur_transition (commande_id, created_at);

/* -------------------------------------------------------------------------- */
/* 5) Frozen document versions: commande_fournisseur_document                  */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.commande_fournisseur_document (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  commande_id   uuid NOT NULL,
  version       integer NOT NULL,
  titre         text NOT NULL,
  payload       jsonb NOT NULL,
  sha256        text NOT NULL,
  motif_revision text,
  generated_by  integer,
  created_at    timestamptz NOT NULL DEFAULT now(),
  sent_at       timestamptz
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commande_fournisseur_document_commande_fkey') THEN
    ALTER TABLE public.commande_fournisseur_document
      ADD CONSTRAINT commande_fournisseur_document_commande_fkey
      FOREIGN KEY (commande_id) REFERENCES public.commande_fournisseur(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commande_fournisseur_document_version_uniq') THEN
    ALTER TABLE public.commande_fournisseur_document
      ADD CONSTRAINT commande_fournisseur_document_version_uniq UNIQUE (commande_id, version);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commande_fournisseur_document_sha_chk') THEN
    ALTER TABLE public.commande_fournisseur_document
      ADD CONSTRAINT commande_fournisseur_document_sha_chk CHECK (sha256 ~ '^[0-9a-f]{64}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commande_fournisseur_document_version_chk') THEN
    ALTER TABLE public.commande_fournisseur_document
      ADD CONSTRAINT commande_fournisseur_document_version_chk CHECK (version >= 1);
  END IF;
  IF to_regclass('public.users') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commande_fournisseur_document_genby_fkey') THEN
    ALTER TABLE public.commande_fournisseur_document
      ADD CONSTRAINT commande_fournisseur_document_genby_fkey
      FOREIGN KEY (generated_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS commande_fournisseur_document_commande_idx
  ON public.commande_fournisseur_document (commande_id, version);

COMMENT ON TABLE public.commande_fournisseur_document IS
  '#172 : versions figées du bon de commande (payload JSON canonique + empreinte SHA-256). Une version envoyée est immuable ; toute modification passe par une nouvelle version motivée.';

/* -------------------------------------------------------------------------- */
/* 6) Immutable need coverage links: commande_fournisseur_ligne_besoin         */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.commande_fournisseur_ligne_besoin (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ligne_id           uuid NOT NULL,
  besoin_type        text NOT NULL,
  besoin_ref         text NOT NULL,
  besoin_of_id       bigint NOT NULL DEFAULT 0,
  of_id              bigint,
  quantite_couverte  numeric(14,3) NOT NULL,
  annule             boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cf_ligne_besoin_ligne_fkey') THEN
    ALTER TABLE public.commande_fournisseur_ligne_besoin
      ADD CONSTRAINT cf_ligne_besoin_ligne_fkey
      FOREIGN KEY (ligne_id) REFERENCES public.commande_fournisseur_ligne(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cf_ligne_besoin_type_chk') THEN
    ALTER TABLE public.commande_fournisseur_ligne_besoin
      ADD CONSTRAINT cf_ligne_besoin_type_chk CHECK (besoin_type = ANY (ARRAY[
        'PIECE_TECHNIQUE_ACHAT','STOCK_LEVEL','MANUEL']));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cf_ligne_besoin_qty_chk') THEN
    ALTER TABLE public.commande_fournisseur_ligne_besoin
      ADD CONSTRAINT cf_ligne_besoin_qty_chk CHECK (quantite_couverte > 0 AND besoin_of_id >= 0);
  END IF;
  IF to_regclass('public.ordres_fabrication') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cf_ligne_besoin_of_fkey') THEN
    ALTER TABLE public.commande_fournisseur_ligne_besoin
      ADD CONSTRAINT cf_ligne_besoin_of_fkey
      FOREIGN KEY (of_id) REFERENCES public.ordres_fabrication(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Anti double-commande : un besoin non-manuel ne peut être couvert que par UNE ligne vivante.
-- besoin_of_id = 0 quand le besoin n'est pas contextualisé par un OF (portable pré-PG15,
-- évite NULLS NOT DISTINCT).
CREATE UNIQUE INDEX IF NOT EXISTS cf_ligne_besoin_couverture_uniq
  ON public.commande_fournisseur_ligne_besoin (besoin_type, besoin_ref, besoin_of_id)
  WHERE NOT annule AND besoin_type <> 'MANUEL';

CREATE INDEX IF NOT EXISTS cf_ligne_besoin_ligne_idx ON public.commande_fournisseur_ligne_besoin (ligne_id);

COMMENT ON TABLE public.commande_fournisseur_ligne_besoin IS
  '#172 : lien immuable besoin source -> ligne générée (anti double-commande). Jamais supprimé : annule=true si la ligne est annulée.';

/* -------------------------------------------------------------------------- */
/* 7) Idempotency replay: commande_fournisseur_idempotence                     */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.commande_fournisseur_idempotence (
  cle          text PRIMARY KEY,
  action       text NOT NULL,
  commande_id  uuid,
  resultat     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cf_idempotence_commande_fkey') THEN
    ALTER TABLE public.commande_fournisseur_idempotence
      ADD CONSTRAINT cf_idempotence_commande_fkey
      FOREIGN KEY (commande_id) REFERENCES public.commande_fournisseur(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cf_idempotence_action_chk') THEN
    ALTER TABLE public.commande_fournisseur_idempotence
      ADD CONSTRAINT cf_idempotence_action_chk CHECK (action = ANY (ARRAY[
        'CREATE','GENERATE','SEND']));
  END IF;
END $$;

/* -------------------------------------------------------------------------- */
/* 8) Additive link on the EXISTING reception subsystem (no second subsystem)  */
/* -------------------------------------------------------------------------- */

ALTER TABLE public.receptions_fournisseurs
  ADD COLUMN IF NOT EXISTS commande_fournisseur_id uuid;

ALTER TABLE public.reception_fournisseur_lignes
  ADD COLUMN IF NOT EXISTS commande_fournisseur_ligne_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'receptions_fournisseurs_cf_fkey') THEN
    ALTER TABLE public.receptions_fournisseurs
      ADD CONSTRAINT receptions_fournisseurs_cf_fkey
      FOREIGN KEY (commande_fournisseur_id) REFERENCES public.commande_fournisseur(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reception_fournisseur_lignes_cf_ligne_fkey') THEN
    ALTER TABLE public.reception_fournisseur_lignes
      ADD CONSTRAINT reception_fournisseur_lignes_cf_ligne_fkey
      FOREIGN KEY (commande_fournisseur_ligne_id) REFERENCES public.commande_fournisseur_ligne(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS receptions_fournisseurs_cf_idx
  ON public.receptions_fournisseurs (commande_fournisseur_id) WHERE commande_fournisseur_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS reception_fournisseur_lignes_cf_ligne_idx
  ON public.reception_fournisseur_lignes (commande_fournisseur_ligne_id) WHERE commande_fournisseur_ligne_id IS NOT NULL;

COMMENT ON COLUMN public.receptions_fournisseurs.commande_fournisseur_id IS
  '#172 : rattachement facultatif d''une réception à une commande fournisseur (le module réceptions reste la seule vérité réception).';
COMMENT ON COLUMN public.reception_fournisseur_lignes.commande_fournisseur_ligne_id IS
  '#172 : imputation facultative d''une ligne de réception sur une ligne de commande fournisseur (quantités reçues calculées par SUM).';

/* -------------------------------------------------------------------------- */
/* 9) updated_at triggers (shared helper public.tg_set_updated_at)             */
/* -------------------------------------------------------------------------- */

DO $$
BEGIN
  IF to_regprocedure('public.tg_set_updated_at()') IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'commande_fournisseur_set_updated_at') THEN
      CREATE TRIGGER commande_fournisseur_set_updated_at
        BEFORE UPDATE ON public.commande_fournisseur
        FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'commande_fournisseur_ligne_set_updated_at') THEN
      CREATE TRIGGER commande_fournisseur_ligne_set_updated_at
        BEFORE UPDATE ON public.commande_fournisseur_ligne
        FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
    END IF;
  END IF;
END $$;

/* -------------------------------------------------------------------------- */
/* 10) Ownership: application role must own the new tables (42501 lesson,      */
/*     2026-07-21). No-op when applied by cerp_app itself via db:patches:up.   */
/* -------------------------------------------------------------------------- */

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    ALTER TABLE public.commande_fournisseur              OWNER TO cerp_app;
    ALTER TABLE public.commande_fournisseur_ligne        OWNER TO cerp_app;
    ALTER TABLE public.commande_fournisseur_transition   OWNER TO cerp_app;
    ALTER TABLE public.commande_fournisseur_document     OWNER TO cerp_app;
    ALTER TABLE public.commande_fournisseur_ligne_besoin OWNER TO cerp_app;
    ALTER TABLE public.commande_fournisseur_idempotence  OWNER TO cerp_app;
  END IF;
END $$;

COMMIT;
