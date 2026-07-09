-- ROLLBACK for db/patches/20260708_gpao_versions_lifecycle.sql (additif → on retire les ajouts).
BEGIN;
DROP INDEX IF EXISTS public.piece_technique_versions_one_applicable_uq;
DROP INDEX IF EXISTS public.gammes_one_current_per_version_uq;
ALTER TABLE public.piece_technique_versions
  DROP CONSTRAINT IF EXISTS piece_technique_versions_statut_check,
  DROP CONSTRAINT IF EXISTS piece_technique_versions_type_changement_check,
  DROP COLUMN IF EXISTS type_changement,
  DROP COLUMN IF EXISTS raison_changement,
  DROP COLUMN IF EXISTS impact_interchangeabilite,
  DROP COLUMN IF EXISTS impact_parents,
  DROP COLUMN IF EXISTS valide_par,
  DROP COLUMN IF EXISTS date_validation,
  DROP COLUMN IF EXISTS date_application,
  DROP COLUMN IF EXISTS commentaire_validation;
ALTER TABLE public.gammes DROP CONSTRAINT IF EXISTS gammes_statut_check;
ALTER TABLE public.pieces_techniques_operations DROP COLUMN IF EXISTS ordre;
COMMIT;
