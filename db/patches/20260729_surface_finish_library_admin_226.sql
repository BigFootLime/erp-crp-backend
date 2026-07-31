-- 20260729_surface_finish_library_admin_226.sql
--
-- Administration de la bibliothèque de finitions (#226 / web #374).
-- Complète 20260728_surface_finish_library_210.sql, ne le remplace pas.
-- ADR : crp-systems-web/docs/adr/ADR-0038-surface-finish-library.md
--
-- ADDITIF, IDEMPOTENT, NON DESTRUCTIF :
--   - 1 nouvelle table (`surface_finish_favorites`, préférence personnelle) ;
--   - 3 colonnes NULLABLES d'archivage sur `surface_finishes`, nommées comme
--     celles d'`articles` (archived_at / archived_by / archive_reason) pour que
--     les deux référentiels s'archivent avec le même vocabulaire ;
--   - 1 index unique PARTIEL qui rend le doublon strict impossible.
--   Aucune table existante n'est renommée, vidée ni recodée. AUCUN BACKFILL.
--
-- Pas d'index trigramme ici, délibérément. `pg_trgm` est installé sur les deux
-- bases et `similarity()` fonctionne SANS index ; la bibliothèque compte
-- quelques centaines de lignes au plus et `articles` est la table la plus
-- écrite de l'ERP. Un GIN trigramme se paierait à chaque écriture pour un gain
-- nul à cette volumétrie. À reconsidérer au-delà de ~50 000 articles.
--
-- Pipeline db/patches (exécuté en tant que cerp_app). Cible : PostgreSQL 17.
--   Preflight : db/patches/support/20260729_surface_finish_library_admin_226.preflight.sql
--   Verify    : db/patches/support/20260729_surface_finish_library_admin_226.verify.sql
--   Rollback  : db/patches/support/20260729_surface_finish_library_admin_226.rollback.sql

BEGIN;

/* -------------------------------------------------------------------------- */
/* 0) Pré-requis structurels                                                  */
/* -------------------------------------------------------------------------- */

DO $$
BEGIN
  IF to_regclass('public.surface_finishes') IS NULL THEN
    RAISE EXCEPTION '#226: public.surface_finishes is missing — apply 20260728_surface_finish_library_210.sql first';
  END IF;
  IF to_regclass('public.users') IS NULL THEN
    RAISE EXCEPTION '#226: public.users is missing';
  END IF;
  IF to_regprocedure('public.surface_finish_norm(text)') IS NULL THEN
    RAISE EXCEPTION '#226: public.surface_finish_norm(text) is missing — apply 20260728_surface_finish_library_210.sql first';
  END IF;
END $$;

/* -------------------------------------------------------------------------- */
/* 1) Favoris — préférence PERSONNELLE, jamais une donnée métier              */
/* -------------------------------------------------------------------------- */
-- Un favori n'engage rien : il n'entre dans aucune spécification, aucune
-- empreinte, aucun document opposable. Il est donc supprimable sans réserve
-- (contrairement aux exigences de gamme), et disparaît avec son utilisateur.

CREATE TABLE IF NOT EXISTS public.surface_finish_favorites (
  user_id     integer     NOT NULL,
  finish_id   uuid        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT surface_finish_favorites_pk PRIMARY KEY (user_id, finish_id),
  CONSTRAINT surface_finish_favorites_user_fk FOREIGN KEY (user_id)
    REFERENCES public.users(id) ON DELETE CASCADE,
  CONSTRAINT surface_finish_favorites_finish_fk FOREIGN KEY (finish_id)
    REFERENCES public.surface_finishes(id) ON DELETE CASCADE
);

COMMENT ON TABLE public.surface_finish_favorites IS
  '#226 — Favoris de bibliothèque, par utilisateur. Préférence d''affichage : n''entre dans aucune spécification ni empreinte.';

-- La liste « mes favoris » se lit par utilisateur ; la PK (user_id, finish_id)
-- la sert déjà. L'index inverse sert le compteur « combien de personnes ont
-- mis cette finition en favori » et la purge par finition.
CREATE INDEX IF NOT EXISTS surface_finish_favorites_finish_idx
  ON public.surface_finish_favorites (finish_id);

/* -------------------------------------------------------------------------- */
/* 2) Archivage d'une finition                                                */
/* -------------------------------------------------------------------------- */
-- `surface_finishes.statut` acceptait déjà 'ARCHIVEE' et 'SUSPENDUE' par CHECK,
-- mais AUCUN code n'y menait : seule l'approbation d'une révision écrivait
-- 'ACTIVE'. On ajoute la traçabilité qui manquait pour que sortir une finition
-- du référentiel soit un acte daté, signé et motivé — pas un simple UPDATE.

ALTER TABLE public.surface_finishes
  ADD COLUMN IF NOT EXISTS archived_at        timestamptz NULL,
  ADD COLUMN IF NOT EXISTS archived_by        integer     NULL,
  ADD COLUMN IF NOT EXISTS archive_reason     text        NULL,
  ADD COLUMN IF NOT EXISTS statut_changed_at  timestamptz NULL,
  ADD COLUMN IF NOT EXISTS statut_changed_by  integer     NULL;

COMMENT ON COLUMN public.surface_finishes.archive_reason IS
  '#226 — Motif d''archivage. Obligatoire côté service : une finition sort du référentiel avec une raison écrite.';

-- Cohérence : archivée ⇔ horodatée et motivée. Écrite en NOT VALID puis
-- validée, pour ne jamais bloquer sur un historique qu'on n'a pas relu — ici
-- les deux bases sont à 0 finition, la validation passe donc à coup sûr, mais
-- la forme reste la bonne si le patch est rejoué sur une base peuplée.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'surface_finishes_archive_coherent'
      AND conrelid = 'public.surface_finishes'::regclass
  ) THEN
    ALTER TABLE public.surface_finishes
      ADD CONSTRAINT surface_finishes_archive_coherent CHECK (
        (statut <> 'ARCHIVEE')
        OR (archived_at IS NOT NULL AND btrim(COALESCE(archive_reason, '')) <> '')
      ) NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'surface_finishes_archive_coherent'
      AND conrelid = 'public.surface_finishes'::regclass
      AND NOT convalidated
  ) THEN
    BEGIN
      ALTER TABLE public.surface_finishes VALIDATE CONSTRAINT surface_finishes_archive_coherent;
    EXCEPTION WHEN check_violation THEN
      -- Base peuplée d'archives antérieures sans motif : la contrainte reste
      -- NOT VALID (elle protège les écritures futures) et le verify le signale.
      RAISE NOTICE '#226: surface_finishes_archive_coherent laissée NOT VALID — des lignes ARCHIVEE sans motif existent.';
    END;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS surface_finishes_archived_at_idx
  ON public.surface_finishes (archived_at)
  WHERE archived_at IS NOT NULL;

/* -------------------------------------------------------------------------- */
/* 3) Anti-doublon du RÉFÉRENTIEL                                             */
/* -------------------------------------------------------------------------- */
-- ADR-0038 tient l'unicité des ARTICLES par `spec_fingerprint`. Rien ne tenait
-- celle des FINITIONS : `surface_finishes_code_uq` porte sur un code alloué par
-- le serveur, donc jamais en collision. Dix « anodisation noire » pouvaient
-- coexister dans la même famille.
--
-- L'identité retenue est le triplet (famille, procédé, désignation courte)
-- NORMALISÉ — accents et casse neutralisés par `surface_finish_norm`, déjà
-- utilisée par la recherche. Ni la description, ni les synonymes, ni la
-- désignation longue n'entrent dans l'identité : ce sont des aides de
-- recherche, deux rédacteurs les écrivent différemment pour la même chose.
--
-- L'index est PARTIEL sur `statut <> 'ARCHIVEE'` : archiver une finition libère
-- son identité, ce qui permet de la remplacer sans détruire l'historique. Deux
-- créations concurrentes ne peuvent pas passer : la seconde lève 23505, que le
-- service traduit en 409 exploitable.
--
-- La détection de doublon APPROCHANT (« anodisation noire » vs « anodisation
-- noire mate ») reste un service consultatif : la base ne peut pas arbitrer une
-- ressemblance, seul le métier le peut.

CREATE UNIQUE INDEX IF NOT EXISTS surface_finishes_identity_uq
  ON public.surface_finishes (
    family_code,
    public.surface_finish_norm(procede),
    public.surface_finish_norm(designation_courte)
  )
  WHERE statut <> 'ARCHIVEE';

COMMENT ON INDEX public.surface_finishes_identity_uq IS
  '#226 — Doublon strict impossible : même famille + même procédé + même désignation normalisée, hors archives.';

COMMIT;
