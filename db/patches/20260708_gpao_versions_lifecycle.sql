-- 20260708_gpao_versions_lifecycle.sql
--
-- GPAO B2 — cycle de vie des versions/indices + ordre des opérations.
-- ADR : crp-systems-web/docs/architecture/pieces-techniques-gpao-target-model.md + B1 audit.
--
-- ADDITIF & NON DESTRUCTIF : ne modifie/supprime aucune colonne existante. Tables cibles
-- (piece_technique_versions, gammes, pieces_techniques_operations) — les deux premières sont
-- vides → aucune migration de données. Idempotent (IF NOT EXISTS / gardes).
--
-- Pipeline normal db/patches (appliqué en tant que cerp_app). Rollback + verify dans support/.
-- Cible : PostgreSQL 17.

BEGIN;

-- 1) piece_technique_versions — statut canonique + champs évolution/modification.
ALTER TABLE public.piece_technique_versions ALTER COLUMN statut SET DEFAULT 'BROUILLON';

DO $$
BEGIN
  -- normalisation (no-op : table vide) puis CHECK statut
  UPDATE public.piece_technique_versions SET statut = upper(statut) WHERE statut IS NOT NULL AND statut <> upper(statut);
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'piece_technique_versions_statut_check'
      AND conrelid = 'public.piece_technique_versions'::regclass
  ) THEN
    ALTER TABLE public.piece_technique_versions
      ADD CONSTRAINT piece_technique_versions_statut_check
      CHECK (statut IN ('BROUILLON','EN_VALIDATION','APPLICABLE','OBSOLETE'));
  END IF;
END $$;

ALTER TABLE public.piece_technique_versions
  ADD COLUMN IF NOT EXISTS type_changement text,
  ADD COLUMN IF NOT EXISTS raison_changement text,
  ADD COLUMN IF NOT EXISTS impact_interchangeabilite boolean,
  ADD COLUMN IF NOT EXISTS impact_parents text,
  ADD COLUMN IF NOT EXISTS valide_par integer,
  ADD COLUMN IF NOT EXISTS date_validation timestamptz,
  ADD COLUMN IF NOT EXISTS date_application date,
  ADD COLUMN IF NOT EXISTS commentaire_validation text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'piece_technique_versions_type_changement_check'
      AND conrelid = 'public.piece_technique_versions'::regclass
  ) THEN
    ALTER TABLE public.piece_technique_versions
      ADD CONSTRAINT piece_technique_versions_type_changement_check
      CHECK (type_changement IS NULL OR type_changement IN ('EVOLUTION','MODIFICATION'));
  END IF;
END $$;

-- Règle métier : une seule version APPLICABLE par pièce technique.
CREATE UNIQUE INDEX IF NOT EXISTS piece_technique_versions_one_applicable_uq
  ON public.piece_technique_versions (piece_technique_id)
  WHERE statut = 'APPLICABLE';

-- 2) gammes — statut canonique + une seule gamme courante par version.
ALTER TABLE public.gammes ALTER COLUMN statut SET DEFAULT 'BROUILLON';

DO $$
BEGIN
  UPDATE public.gammes SET statut = upper(statut) WHERE statut IS NOT NULL AND statut <> upper(statut);
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'gammes_statut_check' AND conrelid = 'public.gammes'::regclass
  ) THEN
    ALTER TABLE public.gammes
      ADD CONSTRAINT gammes_statut_check
      CHECK (statut IN ('BROUILLON','APPLICABLE','OBSOLETE'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS gammes_one_current_per_version_uq
  ON public.gammes (piece_technique_version_id)
  WHERE is_current = true;

-- 3) pieces_techniques_operations — ordre d'affichage distinct de `phase`
--    (le reorder ne doit plus écraser le numéro de phase).
ALTER TABLE public.pieces_techniques_operations
  ADD COLUMN IF NOT EXISTS ordre integer;

COMMIT;
