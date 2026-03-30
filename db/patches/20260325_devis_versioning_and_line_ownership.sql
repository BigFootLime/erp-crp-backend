-- 20260325_devis_versioning_and_line_ownership.sql
-- Additive + idempotent devis versioning and line ownership references.

BEGIN;

ALTER TABLE public.devis
  ADD COLUMN IF NOT EXISTS root_devis_id BIGINT,
  ADD COLUMN IF NOT EXISTS parent_devis_id BIGINT,
  ADD COLUMN IF NOT EXISTS version_number INTEGER;

UPDATE public.devis
SET root_devis_id = id
WHERE root_devis_id IS NULL;

UPDATE public.devis
SET version_number = 1
WHERE version_number IS NULL;

ALTER TABLE public.devis
  ALTER COLUMN root_devis_id SET NOT NULL;

ALTER TABLE public.devis
  ALTER COLUMN version_number SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'devis_version_number_check'
      AND conrelid = 'public.devis'::regclass
  ) THEN
    ALTER TABLE public.devis
      ADD CONSTRAINT devis_version_number_check
      CHECK (version_number > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'devis_root_devis_id_fkey'
      AND conrelid = 'public.devis'::regclass
  ) THEN
    ALTER TABLE public.devis
      ADD CONSTRAINT devis_root_devis_id_fkey
      FOREIGN KEY (root_devis_id) REFERENCES public.devis(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'devis_parent_devis_id_fkey'
      AND conrelid = 'public.devis'::regclass
  ) THEN
    ALTER TABLE public.devis
      ADD CONSTRAINT devis_parent_devis_id_fkey
      FOREIGN KEY (parent_devis_id) REFERENCES public.devis(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS devis_root_devis_id_idx
  ON public.devis(root_devis_id);

CREATE INDEX IF NOT EXISTS devis_parent_devis_id_idx
  ON public.devis(parent_devis_id)
  WHERE parent_devis_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS devis_root_version_uniq
  ON public.devis(root_devis_id, version_number);

ALTER TABLE public.devis_ligne
  ADD COLUMN IF NOT EXISTS article_id UUID,
  ADD COLUMN IF NOT EXISTS piece_technique_id UUID;

DO $$
BEGIN
  IF to_regclass('public.articles') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'devis_ligne_article_id_fkey'
      AND conrelid = 'public.devis_ligne'::regclass
  ) THEN
    ALTER TABLE public.devis_ligne
      ADD CONSTRAINT devis_ligne_article_id_fkey
      FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE SET NULL;
  END IF;

  IF to_regclass('public.pieces_techniques') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'devis_ligne_piece_technique_id_fkey'
      AND conrelid = 'public.devis_ligne'::regclass
  ) THEN
    ALTER TABLE public.devis_ligne
      ADD CONSTRAINT devis_ligne_piece_technique_id_fkey
      FOREIGN KEY (piece_technique_id) REFERENCES public.pieces_techniques(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS devis_ligne_article_id_idx
  ON public.devis_ligne(article_id)
  WHERE article_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS devis_ligne_piece_technique_id_idx
  ON public.devis_ligne(piece_technique_id)
  WHERE piece_technique_id IS NOT NULL;

WITH resolved AS (
  SELECT
    dl.id AS devis_ligne_id,
    art.article_id,
    COALESCE(art.piece_technique_id, pt.piece_technique_id) AS piece_technique_id
  FROM public.devis_ligne dl
  LEFT JOIN LATERAL (
    SELECT
      a.id AS article_id,
      a.piece_technique_id
    FROM public.articles a
    LEFT JOIN public.pieces_techniques apt
      ON apt.id = a.piece_technique_id
    WHERE dl.code_piece IS NOT NULL
      AND (
        a.code = btrim(dl.code_piece)
        OR apt.code_piece = btrim(dl.code_piece)
      )
    ORDER BY
      (a.code = btrim(dl.code_piece)) DESC,
      a.updated_at DESC NULLS LAST,
      a.created_at DESC NULLS LAST,
      a.id ASC
    LIMIT 1
  ) art ON TRUE
  LEFT JOIN LATERAL (
    SELECT pt.id AS piece_technique_id
    FROM public.pieces_techniques pt
    WHERE dl.code_piece IS NOT NULL
      AND pt.code_piece = btrim(dl.code_piece)
    ORDER BY pt.updated_at DESC NULLS LAST, pt.created_at DESC NULLS LAST, pt.id ASC
    LIMIT 1
  ) pt ON TRUE
  WHERE dl.article_id IS NULL OR dl.piece_technique_id IS NULL
)
UPDATE public.devis_ligne dl
SET
  article_id = COALESCE(dl.article_id, resolved.article_id),
  piece_technique_id = COALESCE(dl.piece_technique_id, resolved.piece_technique_id)
FROM resolved
WHERE dl.id = resolved.devis_ligne_id
  AND (resolved.article_id IS NOT NULL OR resolved.piece_technique_id IS NOT NULL);

COMMIT;
