-- Stock articles category widening + stock-managed behavior.
-- Idempotent patch.

BEGIN;

ALTER TABLE public.articles
  ADD COLUMN IF NOT EXISTS article_category TEXT;

ALTER TABLE public.articles
  ADD COLUMN IF NOT EXISTS stock_managed BOOLEAN NOT NULL DEFAULT true;

UPDATE public.articles
SET article_category = CASE
  WHEN article_type = 'PIECE_TECHNIQUE' THEN 'PIECE_TECHNIQUE'
  ELSE 'MATIERE_PREMIERE'
END
WHERE article_category IS NULL OR btrim(article_category) = '';

ALTER TABLE public.articles
  ALTER COLUMN article_category SET DEFAULT 'MATIERE_PREMIERE';

UPDATE public.articles
SET lot_tracking = false
WHERE stock_managed = false AND lot_tracking = true;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'articles_article_category_check'
      AND conrelid = 'public.articles'::regclass
  ) THEN
    ALTER TABLE public.articles
      ADD CONSTRAINT articles_article_category_check
      CHECK (article_category IN ('PIECE_TECHNIQUE', 'MATIERE_PREMIERE', 'TRAITEMENT', 'FOURNITURE'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'articles_stock_managed_lot_tracking_check'
      AND conrelid = 'public.articles'::regclass
  ) THEN
    ALTER TABLE public.articles
      ADD CONSTRAINT articles_stock_managed_lot_tracking_check
      CHECK (stock_managed OR NOT lot_tracking);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'articles_piece_type_consistency_check'
      AND conrelid = 'public.articles'::regclass
  ) THEN
    ALTER TABLE public.articles
      ADD CONSTRAINT articles_piece_type_consistency_check
      CHECK (
        (article_type = 'PIECE_TECHNIQUE' AND piece_technique_id IS NOT NULL AND article_category = 'PIECE_TECHNIQUE')
        OR
        (article_type = 'PURCHASED' AND article_category IN ('MATIERE_PREMIERE', 'TRAITEMENT', 'FOURNITURE'))
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS articles_article_category_idx ON public.articles (article_category);
CREATE INDEX IF NOT EXISTS articles_stock_managed_idx ON public.articles (stock_managed);
CREATE UNIQUE INDEX IF NOT EXISTS articles_piece_technique_id_uniq
  ON public.articles (piece_technique_id)
  WHERE piece_technique_id IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'pieces_techniques'
      AND column_name = 'article_id'
  ) THEN
    UPDATE public.pieces_techniques pt
    SET article_id = a.id
    FROM public.articles a
    WHERE a.article_type = 'PIECE_TECHNIQUE'
      AND a.piece_technique_id = pt.id
      AND pt.article_id IS DISTINCT FROM a.id;
  END IF;
END $$;

COMMIT;
