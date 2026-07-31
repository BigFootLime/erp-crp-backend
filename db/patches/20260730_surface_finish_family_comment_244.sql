-- #244 -- Commentaire automatique parametre au niveau de la famille de finition.
-- Additif et idempotent : ne modifie ni les codes FIN/ART, ni les revisions existantes.

BEGIN;

ALTER TABLE public.surface_finish_families
  ADD COLUMN IF NOT EXISTS commentaire_template text NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'surface_finish_families_commentaire_template_length_check'
      AND conrelid = 'public.surface_finish_families'::regclass
  ) THEN
    ALTER TABLE public.surface_finish_families
      ADD CONSTRAINT surface_finish_families_commentaire_template_length_check
      CHECK (commentaire_template IS NULL OR char_length(commentaire_template) <= 4000);
  END IF;
END $$;

COMMENT ON COLUMN public.surface_finish_families.commentaire_template IS
  '#244 -- Phrase ou modele commun ajoute au commentaire genere de chaque article de traitement de cette famille.';

COMMIT;
