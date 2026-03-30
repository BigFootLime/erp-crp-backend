-- 20260325_pieces_techniques_ownership_versioning.sql
-- Additive + idempotent piece-technique ownership/versioning foundation.

BEGIN;

ALTER TABLE public.pieces_techniques
  ADD COLUMN IF NOT EXISTS article_id UUID,
  ADD COLUMN IF NOT EXISTS root_piece_technique_id UUID,
  ADD COLUMN IF NOT EXISTS parent_piece_technique_id UUID,
  ADD COLUMN IF NOT EXISTS version_number INTEGER;

UPDATE public.pieces_techniques pt
SET article_id = a.id
FROM public.articles a
WHERE a.piece_technique_id = pt.id
  AND pt.article_id IS NULL;

UPDATE public.pieces_techniques
SET root_piece_technique_id = id
WHERE root_piece_technique_id IS NULL;

UPDATE public.pieces_techniques
SET version_number = 1
WHERE version_number IS NULL;

ALTER TABLE public.pieces_techniques
  ALTER COLUMN root_piece_technique_id SET NOT NULL;

ALTER TABLE public.pieces_techniques
  ALTER COLUMN version_number SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pieces_techniques_version_number_check'
      AND conrelid = 'public.pieces_techniques'::regclass
  ) THEN
    ALTER TABLE public.pieces_techniques
      ADD CONSTRAINT pieces_techniques_version_number_check
      CHECK (version_number > 0);
  END IF;

  IF to_regclass('public.articles') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pieces_techniques_article_id_fkey'
      AND conrelid = 'public.pieces_techniques'::regclass
  ) THEN
    ALTER TABLE public.pieces_techniques
      ADD CONSTRAINT pieces_techniques_article_id_fkey
      FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pieces_techniques_root_piece_technique_id_fkey'
      AND conrelid = 'public.pieces_techniques'::regclass
  ) THEN
    ALTER TABLE public.pieces_techniques
      ADD CONSTRAINT pieces_techniques_root_piece_technique_id_fkey
      FOREIGN KEY (root_piece_technique_id) REFERENCES public.pieces_techniques(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pieces_techniques_parent_piece_technique_id_fkey'
      AND conrelid = 'public.pieces_techniques'::regclass
  ) THEN
    ALTER TABLE public.pieces_techniques
      ADD CONSTRAINT pieces_techniques_parent_piece_technique_id_fkey
      FOREIGN KEY (parent_piece_technique_id) REFERENCES public.pieces_techniques(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS pieces_techniques_article_id_idx
  ON public.pieces_techniques(article_id)
  WHERE article_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS pieces_techniques_root_piece_technique_id_idx
  ON public.pieces_techniques(root_piece_technique_id);

CREATE INDEX IF NOT EXISTS pieces_techniques_parent_piece_technique_id_idx
  ON public.pieces_techniques(parent_piece_technique_id)
  WHERE parent_piece_technique_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS pieces_techniques_root_version_uniq
  ON public.pieces_techniques(root_piece_technique_id, version_number);

COMMIT;
