-- 20260708_gpao_gammes_operations_types.sql
--
-- GPAO B2.2 — gammes (nom/commentaire, statut aligné sur la version) + types d'opérations.
-- ADDITIF & NON DESTRUCTIF : nouvelles colonnes nullables + élargissement d'un CHECK sur table
-- vide. Les opérations existantes (sans gamme_id) restent lisibles et inchangées. Idempotent.
-- Pipeline db/patches (cerp_app). Cible : PostgreSQL 17. Rollback dans support/.

BEGIN;

-- 1) gammes : nom + commentaire ; statut aligné sur le cycle de vie des versions.
ALTER TABLE public.gammes
  ADD COLUMN IF NOT EXISTS nom text,
  ADD COLUMN IF NOT EXISTS commentaire text;

ALTER TABLE public.gammes DROP CONSTRAINT IF EXISTS gammes_statut_check;
ALTER TABLE public.gammes
  ADD CONSTRAINT gammes_statut_check
  CHECK (statut IN ('BROUILLON','EN_VALIDATION','APPLICABLE','OBSOLETE'));

-- 2) opérations : type d'opération (découpage usinage), poste de charge, consignes.
ALTER TABLE public.pieces_techniques_operations
  ADD COLUMN IF NOT EXISTS type_operation text,
  ADD COLUMN IF NOT EXISTS poste_id uuid,
  ADD COLUMN IF NOT EXISTS consignes text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pieces_techniques_operations_type_operation_check'
      AND conrelid = 'public.pieces_techniques_operations'::regclass
  ) THEN
    ALTER TABLE public.pieces_techniques_operations
      ADD CONSTRAINT pieces_techniques_operations_type_operation_check
      CHECK (type_operation IS NULL OR type_operation IN
        ('TOURNAGE','FRAISAGE','REPRISE','CONTROLE','LAVAGE','SOUS_TRAITANCE','EMBALLAGE','AUTRE'));
  END IF;
END $$;

COMMIT;
