-- 20260707_pieces_techniques_gpao_versions_gammes.sql
--
-- GPAO — consolidation Pièces techniques (P2).
-- ADR : crp-systems-web/docs/architecture/pieces-techniques-gpao-target-model.md
--
-- ADDITIF & NON DESTRUCTIF :
--   - nouvelles tables : piece_technique_versions (indice/version/plan), gammes (gamme d'une version) ;
--   - colonnes NULLABLES ajoutées à pieces_techniques_operations (+gamme_id, +machine_id)
--     et pieces_techniques_nomenclature (+parent/child_version_id, +child_article_id) ;
--   - dépréciation (COMMENT) du cluster legacy piece_technique/operation_technique/achat_technique.
--   Aucune table/colonne existante n'est modifiée ou supprimée → le code actuel reste compatible.
--   Tables cibles vides → aucune migration de données. Le legacy N'EST PAS supprimé (P4 ultérieure).
--
-- Pipeline normal db/patches (appliqué en tant que cerp_app, qui possède ces tables et a CREATE
-- sur public). Idempotent (IF NOT EXISTS partout).
--   Rollback : db/patches/support/20260707_pieces_techniques_gpao_versions_gammes.rollback.sql
--   Verify   : db/patches/support/20260707_pieces_techniques_gpao_versions_gammes.verify.sql
--
-- Cible : PostgreSQL 17.

BEGIN;

-- 1) piece_technique_versions — indice / version / plan d'une pièce (identité = pieces_techniques).
CREATE TABLE IF NOT EXISTS public.piece_technique_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  piece_technique_id uuid NOT NULL REFERENCES public.pieces_techniques(id) ON DELETE CASCADE,
  indice text NOT NULL,
  plan_reference text,
  matiere_prevue text,
  statut text NOT NULL DEFAULT 'brouillon',
  is_current boolean NOT NULL DEFAULT false,
  commentaire_revision text,
  date_revision timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by integer,
  updated_by integer,
  CONSTRAINT piece_technique_versions_piece_indice_uq UNIQUE (piece_technique_id, indice)
);
CREATE INDEX IF NOT EXISTS piece_technique_versions_piece_idx
  ON public.piece_technique_versions (piece_technique_id);

-- 2) gammes — gamme d'une version (la gamme suit l'indice).
CREATE TABLE IF NOT EXISTS public.gammes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  piece_technique_version_id uuid NOT NULL REFERENCES public.piece_technique_versions(id) ON DELETE CASCADE,
  code text,
  designation text,
  statut text NOT NULL DEFAULT 'brouillon',
  is_current boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by integer,
  updated_by integer
);
CREATE INDEX IF NOT EXISTS gammes_version_idx
  ON public.gammes (piece_technique_version_id);

-- 3) pieces_techniques_operations : lien canonique vers la gamme + machine (additif, nullable).
ALTER TABLE public.pieces_techniques_operations
  ADD COLUMN IF NOT EXISTS gamme_id uuid REFERENCES public.gammes(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS machine_id uuid REFERENCES public.machines(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS pt_operations_gamme_idx
  ON public.pieces_techniques_operations (gamme_id);

-- 4) pieces_techniques_nomenclature : suivre l'indice (versions) + ligne article (acheté/standard/matière).
ALTER TABLE public.pieces_techniques_nomenclature
  ADD COLUMN IF NOT EXISTS parent_piece_technique_version_id uuid
    REFERENCES public.piece_technique_versions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS child_piece_technique_version_id uuid
    REFERENCES public.piece_technique_versions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS child_article_id uuid
    REFERENCES public.articles(id) ON DELETE SET NULL;

-- 5) Déprécier le cluster legacy (informatif, non destructif — suppression prévue en P4).
DO $$
BEGIN
  IF to_regclass('public.piece_technique') IS NOT NULL THEN
    EXECUTE 'COMMENT ON TABLE public.piece_technique IS ''DEPRECATED (2026-07-07) — utiliser pieces_techniques ; suppression prévue P4''';
  END IF;
  IF to_regclass('public.operation_technique') IS NOT NULL THEN
    EXECUTE 'COMMENT ON TABLE public.operation_technique IS ''DEPRECATED (2026-07-07) — utiliser pieces_techniques_operations ; suppression prévue P4''';
  END IF;
  IF to_regclass('public.achat_technique') IS NOT NULL THEN
    EXECUTE 'COMMENT ON TABLE public.achat_technique IS ''DEPRECATED (2026-07-07) — utiliser pieces_techniques_achats ; suppression prévue P4''';
  END IF;
END $$;

COMMIT;
