-- 20260325_articles_versioning_status_project_categories.sql
-- Additive + idempotent article versioning/workflow/project + multi-category relation.

BEGIN;

ALTER TABLE public.articles
  ADD COLUMN IF NOT EXISTS root_article_id UUID,
  ADD COLUMN IF NOT EXISTS parent_article_id UUID,
  ADD COLUMN IF NOT EXISTS version_number INTEGER,
  ADD COLUMN IF NOT EXISTS plan_index INTEGER,
  ADD COLUMN IF NOT EXISTS status TEXT,
  ADD COLUMN IF NOT EXISTS projet_id BIGINT;

UPDATE public.articles
SET root_article_id = id
WHERE root_article_id IS NULL;

UPDATE public.articles
SET version_number = 1
WHERE version_number IS NULL;

UPDATE public.articles
SET plan_index = 1
WHERE plan_index IS NULL OR plan_index <= 0;

UPDATE public.articles
SET status = 'VALIDE'
WHERE status IS NULL OR btrim(status) = '';

ALTER TABLE public.articles
  ALTER COLUMN root_article_id SET NOT NULL;

ALTER TABLE public.articles
  ALTER COLUMN version_number SET NOT NULL;

ALTER TABLE public.articles
  ALTER COLUMN plan_index SET NOT NULL;

ALTER TABLE public.articles
  ALTER COLUMN status SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'articles_version_number_check'
      AND conrelid = 'public.articles'::regclass
  ) THEN
    ALTER TABLE public.articles
      ADD CONSTRAINT articles_version_number_check
      CHECK (version_number > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'articles_plan_index_check'
      AND conrelid = 'public.articles'::regclass
  ) THEN
    ALTER TABLE public.articles
      ADD CONSTRAINT articles_plan_index_check
      CHECK (plan_index > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'articles_status_check'
      AND conrelid = 'public.articles'::regclass
  ) THEN
    ALTER TABLE public.articles
      ADD CONSTRAINT articles_status_check
      CHECK (status IN ('EN_DEVIS', 'VALIDE'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'articles_root_article_id_fkey'
      AND conrelid = 'public.articles'::regclass
  ) THEN
    ALTER TABLE public.articles
      ADD CONSTRAINT articles_root_article_id_fkey
      FOREIGN KEY (root_article_id) REFERENCES public.articles(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'articles_parent_article_id_fkey'
      AND conrelid = 'public.articles'::regclass
  ) THEN
    ALTER TABLE public.articles
      ADD CONSTRAINT articles_parent_article_id_fkey
      FOREIGN KEY (parent_article_id) REFERENCES public.articles(id) ON DELETE SET NULL;
  END IF;

  IF to_regclass('public.affaire') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'articles_projet_id_fkey'
      AND conrelid = 'public.articles'::regclass
  ) THEN
    ALTER TABLE public.articles
      ADD CONSTRAINT articles_projet_id_fkey
      FOREIGN KEY (projet_id) REFERENCES public.affaire(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS articles_root_article_id_idx
  ON public.articles(root_article_id);

CREATE INDEX IF NOT EXISTS articles_parent_article_id_idx
  ON public.articles(parent_article_id)
  WHERE parent_article_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS articles_status_idx
  ON public.articles(status);

CREATE INDEX IF NOT EXISTS articles_projet_id_idx
  ON public.articles(projet_id)
  WHERE projet_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS articles_root_version_uniq
  ON public.articles(root_article_id, version_number);

CREATE TABLE IF NOT EXISTS public.article_category_ref (
  code TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 100,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO public.article_category_ref (code, label, sort_order)
VALUES
  ('piece_finie_fabriquee', 'Pièce finie / Fabriquée', 10),
  ('matiere_premiere', 'Matière Première', 20),
  ('traitement_surface', 'Traitement de Surface', 30),
  ('achat_revente', 'Achat-Revente', 40),
  ('achat_transforme', 'Achat-Transformé', 50),
  ('sous_traitance', 'Sous-traitance', 60)
ON CONFLICT (code) DO UPDATE
SET
  label = EXCLUDED.label,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();

CREATE TABLE IF NOT EXISTS public.article_category_link (
  article_id UUID NOT NULL,
  category_code TEXT NOT NULL,
  is_primary BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by INTEGER NULL,
  PRIMARY KEY (article_id, category_code)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'article_category_link_article_id_fkey'
      AND conrelid = 'public.article_category_link'::regclass
  ) THEN
    ALTER TABLE public.article_category_link
      ADD CONSTRAINT article_category_link_article_id_fkey
      FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'article_category_link_category_code_fkey'
      AND conrelid = 'public.article_category_link'::regclass
  ) THEN
    ALTER TABLE public.article_category_link
      ADD CONSTRAINT article_category_link_category_code_fkey
      FOREIGN KEY (category_code) REFERENCES public.article_category_ref(code) ON DELETE RESTRICT;
  END IF;

  IF to_regclass('public.users') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'article_category_link_created_by_fkey'
      AND conrelid = 'public.article_category_link'::regclass
  ) THEN
    ALTER TABLE public.article_category_link
      ADD CONSTRAINT article_category_link_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS article_category_link_category_code_idx
  ON public.article_category_link(category_code);

CREATE UNIQUE INDEX IF NOT EXISTS article_category_link_primary_uniq
  ON public.article_category_link(article_id)
  WHERE is_primary = true;

INSERT INTO public.article_category_link (article_id, category_code, is_primary)
SELECT
  a.id,
  CASE a.article_category
    WHEN 'PIECE_TECHNIQUE' THEN 'piece_finie_fabriquee'
    WHEN 'fabrique' THEN 'piece_finie_fabriquee'
    WHEN 'MATIERE_PREMIERE' THEN 'matiere_premiere'
    WHEN 'matiere' THEN 'matiere_premiere'
    WHEN 'TRAITEMENT' THEN 'traitement_surface'
    WHEN 'traitement' THEN 'traitement_surface'
    WHEN 'FOURNITURE' THEN 'achat_revente'
    WHEN 'achat' THEN 'achat_revente'
    ELSE 'achat_revente'
  END AS category_code,
  true AS is_primary
FROM public.articles a
ON CONFLICT (article_id, category_code) DO UPDATE
SET is_primary = true;

COMMIT;
