-- ROLLBACK for db/patches/20260708_gpao_nomenclature_versioned.sql
-- NB : re-mettre NOT NULL n'est sûr que si aucune ligne article-seule n'existe.
BEGIN;
DROP INDEX IF EXISTS public.pt_nomenclature_child_article_idx;
ALTER TABLE public.pieces_techniques_nomenclature DROP CONSTRAINT IF EXISTS pt_nomenclature_child_xor_article;
-- Restaure NOT NULL uniquement si plus aucune ligne sans child_piece_technique_id.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.pieces_techniques_nomenclature WHERE child_piece_technique_id IS NULL) THEN
    ALTER TABLE public.pieces_techniques_nomenclature ALTER COLUMN child_piece_technique_id SET NOT NULL;
  END IF;
END $$;
COMMIT;
