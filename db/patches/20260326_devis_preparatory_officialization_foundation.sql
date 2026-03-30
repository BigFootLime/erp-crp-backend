-- 20260326_devis_preparatory_officialization_foundation.sql
-- Additive/idempotent foundation for quote-only preparatory entities
-- and explicit promotion traceability into commande/official entities.

BEGIN;

CREATE TABLE IF NOT EXISTS public.article_devis (
  id UUID PRIMARY KEY,
  devis_id BIGINT NOT NULL,
  devis_ligne_id BIGINT NULL,
  root_article_devis_id UUID NOT NULL,
  parent_article_devis_id UUID NULL,
  version_number INTEGER NOT NULL DEFAULT 1,
  code TEXT NOT NULL,
  designation TEXT NOT NULL,
  primary_category TEXT NOT NULL,
  article_categories TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  family_code TEXT NOT NULL,
  plan_index INTEGER NOT NULL DEFAULT 1,
  projet_id BIGINT NULL,
  source_official_article_id UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.dossier_technique_piece_devis (
  id UUID PRIMARY KEY,
  article_devis_id UUID NOT NULL,
  devis_id BIGINT NOT NULL,
  root_dossier_devis_id UUID NOT NULL,
  parent_dossier_devis_id UUID NULL,
  version_number INTEGER NOT NULL DEFAULT 1,
  code_piece TEXT NOT NULL,
  designation TEXT NOT NULL,
  source_official_piece_technique_id UUID NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.article_devis_promotion (
  id BIGSERIAL PRIMARY KEY,
  source_article_devis_id UUID NOT NULL,
  promoted_article_id UUID NOT NULL,
  commande_id BIGINT NOT NULL,
  commande_ligne_id BIGINT NULL,
  promoted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT article_devis_promotion_source_uniq UNIQUE (source_article_devis_id)
);

CREATE TABLE IF NOT EXISTS public.dossier_technique_piece_devis_promotion (
  id BIGSERIAL PRIMARY KEY,
  source_dossier_devis_id UUID NOT NULL,
  promoted_piece_technique_id UUID NOT NULL,
  commande_id BIGINT NOT NULL,
  commande_ligne_id BIGINT NULL,
  promoted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT dossier_devis_promotion_source_uniq UNIQUE (source_dossier_devis_id)
);

ALTER TABLE public.commande_client
  ADD COLUMN IF NOT EXISTS source_devis_version_id BIGINT NULL;

ALTER TABLE public.commande_ligne
  ADD COLUMN IF NOT EXISTS source_article_devis_id UUID NULL,
  ADD COLUMN IF NOT EXISTS source_dossier_devis_id UUID NULL;

UPDATE public.commande_client
SET source_devis_version_id = devis_id
WHERE source_devis_version_id IS NULL
  AND devis_id IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'article_devis_version_number_check'
      AND conrelid = 'public.article_devis'::regclass
  ) THEN
    ALTER TABLE public.article_devis
      ADD CONSTRAINT article_devis_version_number_check CHECK (version_number > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'article_devis_plan_index_check'
      AND conrelid = 'public.article_devis'::regclass
  ) THEN
    ALTER TABLE public.article_devis
      ADD CONSTRAINT article_devis_plan_index_check CHECK (plan_index > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'dossier_devis_version_number_check'
      AND conrelid = 'public.dossier_technique_piece_devis'::regclass
  ) THEN
    ALTER TABLE public.dossier_technique_piece_devis
      ADD CONSTRAINT dossier_devis_version_number_check CHECK (version_number > 0);
  END IF;

  IF to_regclass('public.devis') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'article_devis_devis_id_fkey'
      AND conrelid = 'public.article_devis'::regclass
  ) THEN
    ALTER TABLE public.article_devis
      ADD CONSTRAINT article_devis_devis_id_fkey
      FOREIGN KEY (devis_id) REFERENCES public.devis(id) ON DELETE CASCADE;
  END IF;

  IF to_regclass('public.devis_ligne') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'article_devis_devis_ligne_id_fkey'
      AND conrelid = 'public.article_devis'::regclass
  ) THEN
    ALTER TABLE public.article_devis
      ADD CONSTRAINT article_devis_devis_ligne_id_fkey
      FOREIGN KEY (devis_ligne_id) REFERENCES public.devis_ligne(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'article_devis_root_article_devis_id_fkey'
      AND conrelid = 'public.article_devis'::regclass
  ) THEN
    ALTER TABLE public.article_devis
      ADD CONSTRAINT article_devis_root_article_devis_id_fkey
      FOREIGN KEY (root_article_devis_id) REFERENCES public.article_devis(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'article_devis_parent_article_devis_id_fkey'
      AND conrelid = 'public.article_devis'::regclass
  ) THEN
    ALTER TABLE public.article_devis
      ADD CONSTRAINT article_devis_parent_article_devis_id_fkey
      FOREIGN KEY (parent_article_devis_id) REFERENCES public.article_devis(id) ON DELETE SET NULL;
  END IF;

  IF to_regclass('public.affaire') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'article_devis_projet_id_fkey'
      AND conrelid = 'public.article_devis'::regclass
  ) THEN
    ALTER TABLE public.article_devis
      ADD CONSTRAINT article_devis_projet_id_fkey
      FOREIGN KEY (projet_id) REFERENCES public.affaire(id) ON DELETE SET NULL;
  END IF;

  IF to_regclass('public.articles') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'article_devis_source_official_article_id_fkey'
      AND conrelid = 'public.article_devis'::regclass
  ) THEN
    ALTER TABLE public.article_devis
      ADD CONSTRAINT article_devis_source_official_article_id_fkey
      FOREIGN KEY (source_official_article_id) REFERENCES public.articles(id) ON DELETE SET NULL;
  END IF;

  IF to_regclass('public.article_devis') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'dossier_devis_article_devis_id_fkey'
      AND conrelid = 'public.dossier_technique_piece_devis'::regclass
  ) THEN
    ALTER TABLE public.dossier_technique_piece_devis
      ADD CONSTRAINT dossier_devis_article_devis_id_fkey
      FOREIGN KEY (article_devis_id) REFERENCES public.article_devis(id) ON DELETE CASCADE;
  END IF;

  IF to_regclass('public.devis') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'dossier_devis_devis_id_fkey'
      AND conrelid = 'public.dossier_technique_piece_devis'::regclass
  ) THEN
    ALTER TABLE public.dossier_technique_piece_devis
      ADD CONSTRAINT dossier_devis_devis_id_fkey
      FOREIGN KEY (devis_id) REFERENCES public.devis(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'dossier_devis_root_dossier_devis_id_fkey'
      AND conrelid = 'public.dossier_technique_piece_devis'::regclass
  ) THEN
    ALTER TABLE public.dossier_technique_piece_devis
      ADD CONSTRAINT dossier_devis_root_dossier_devis_id_fkey
      FOREIGN KEY (root_dossier_devis_id) REFERENCES public.dossier_technique_piece_devis(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'dossier_devis_parent_dossier_devis_id_fkey'
      AND conrelid = 'public.dossier_technique_piece_devis'::regclass
  ) THEN
    ALTER TABLE public.dossier_technique_piece_devis
      ADD CONSTRAINT dossier_devis_parent_dossier_devis_id_fkey
      FOREIGN KEY (parent_dossier_devis_id) REFERENCES public.dossier_technique_piece_devis(id) ON DELETE SET NULL;
  END IF;

  IF to_regclass('public.pieces_techniques') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'dossier_devis_source_official_piece_id_fkey'
      AND conrelid = 'public.dossier_technique_piece_devis'::regclass
  ) THEN
    ALTER TABLE public.dossier_technique_piece_devis
      ADD CONSTRAINT dossier_devis_source_official_piece_id_fkey
      FOREIGN KEY (source_official_piece_technique_id) REFERENCES public.pieces_techniques(id) ON DELETE SET NULL;
  END IF;

  IF to_regclass('public.article_devis') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'article_devis_promotion_source_fkey'
      AND conrelid = 'public.article_devis_promotion'::regclass
  ) THEN
    ALTER TABLE public.article_devis_promotion
      ADD CONSTRAINT article_devis_promotion_source_fkey
      FOREIGN KEY (source_article_devis_id) REFERENCES public.article_devis(id) ON DELETE CASCADE;
  END IF;

  IF to_regclass('public.articles') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'article_devis_promotion_article_fkey'
      AND conrelid = 'public.article_devis_promotion'::regclass
  ) THEN
    ALTER TABLE public.article_devis_promotion
      ADD CONSTRAINT article_devis_promotion_article_fkey
      FOREIGN KEY (promoted_article_id) REFERENCES public.articles(id) ON DELETE RESTRICT;
  END IF;

  IF to_regclass('public.commande_client') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'article_devis_promotion_commande_fkey'
      AND conrelid = 'public.article_devis_promotion'::regclass
  ) THEN
    ALTER TABLE public.article_devis_promotion
      ADD CONSTRAINT article_devis_promotion_commande_fkey
      FOREIGN KEY (commande_id) REFERENCES public.commande_client(id) ON DELETE CASCADE;
  END IF;

  IF to_regclass('public.commande_ligne') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'article_devis_promotion_commande_ligne_fkey'
      AND conrelid = 'public.article_devis_promotion'::regclass
  ) THEN
    ALTER TABLE public.article_devis_promotion
      ADD CONSTRAINT article_devis_promotion_commande_ligne_fkey
      FOREIGN KEY (commande_ligne_id) REFERENCES public.commande_ligne(id) ON DELETE SET NULL;
  END IF;

  IF to_regclass('public.dossier_technique_piece_devis') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'dossier_devis_promotion_source_fkey'
      AND conrelid = 'public.dossier_technique_piece_devis_promotion'::regclass
  ) THEN
    ALTER TABLE public.dossier_technique_piece_devis_promotion
      ADD CONSTRAINT dossier_devis_promotion_source_fkey
      FOREIGN KEY (source_dossier_devis_id) REFERENCES public.dossier_technique_piece_devis(id) ON DELETE CASCADE;
  END IF;

  IF to_regclass('public.pieces_techniques') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'dossier_devis_promotion_piece_fkey'
      AND conrelid = 'public.dossier_technique_piece_devis_promotion'::regclass
  ) THEN
    ALTER TABLE public.dossier_technique_piece_devis_promotion
      ADD CONSTRAINT dossier_devis_promotion_piece_fkey
      FOREIGN KEY (promoted_piece_technique_id) REFERENCES public.pieces_techniques(id) ON DELETE RESTRICT;
  END IF;

  IF to_regclass('public.commande_client') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'dossier_devis_promotion_commande_fkey'
      AND conrelid = 'public.dossier_technique_piece_devis_promotion'::regclass
  ) THEN
    ALTER TABLE public.dossier_technique_piece_devis_promotion
      ADD CONSTRAINT dossier_devis_promotion_commande_fkey
      FOREIGN KEY (commande_id) REFERENCES public.commande_client(id) ON DELETE CASCADE;
  END IF;

  IF to_regclass('public.commande_ligne') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'dossier_devis_promotion_commande_ligne_fkey'
      AND conrelid = 'public.dossier_technique_piece_devis_promotion'::regclass
  ) THEN
    ALTER TABLE public.dossier_technique_piece_devis_promotion
      ADD CONSTRAINT dossier_devis_promotion_commande_ligne_fkey
      FOREIGN KEY (commande_ligne_id) REFERENCES public.commande_ligne(id) ON DELETE SET NULL;
  END IF;

  IF to_regclass('public.devis') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'commande_client_source_devis_version_id_fkey'
      AND conrelid = 'public.commande_client'::regclass
  ) THEN
    ALTER TABLE public.commande_client
      ADD CONSTRAINT commande_client_source_devis_version_id_fkey
      FOREIGN KEY (source_devis_version_id) REFERENCES public.devis(id) ON DELETE SET NULL;
  END IF;

  IF to_regclass('public.article_devis') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'commande_ligne_source_article_devis_id_fkey'
      AND conrelid = 'public.commande_ligne'::regclass
  ) THEN
    ALTER TABLE public.commande_ligne
      ADD CONSTRAINT commande_ligne_source_article_devis_id_fkey
      FOREIGN KEY (source_article_devis_id) REFERENCES public.article_devis(id) ON DELETE SET NULL;
  END IF;

  IF to_regclass('public.dossier_technique_piece_devis') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'commande_ligne_source_dossier_devis_id_fkey'
      AND conrelid = 'public.commande_ligne'::regclass
  ) THEN
    ALTER TABLE public.commande_ligne
      ADD CONSTRAINT commande_ligne_source_dossier_devis_id_fkey
      FOREIGN KEY (source_dossier_devis_id) REFERENCES public.dossier_technique_piece_devis(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS article_devis_devis_ligne_unique
  ON public.article_devis(devis_ligne_id)
  WHERE devis_ligne_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS article_devis_root_version_uniq
  ON public.article_devis(root_article_devis_id, version_number);

CREATE INDEX IF NOT EXISTS article_devis_devis_id_idx
  ON public.article_devis(devis_id);

CREATE INDEX IF NOT EXISTS article_devis_code_idx
  ON public.article_devis(code);

CREATE INDEX IF NOT EXISTS article_devis_source_official_article_idx
  ON public.article_devis(source_official_article_id)
  WHERE source_official_article_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS dossier_devis_root_version_uniq
  ON public.dossier_technique_piece_devis(root_dossier_devis_id, version_number);

CREATE INDEX IF NOT EXISTS dossier_devis_article_devis_idx
  ON public.dossier_technique_piece_devis(article_devis_id);

CREATE UNIQUE INDEX IF NOT EXISTS dossier_devis_article_devis_unique
  ON public.dossier_technique_piece_devis(article_devis_id);

CREATE INDEX IF NOT EXISTS dossier_devis_devis_id_idx
  ON public.dossier_technique_piece_devis(devis_id);

CREATE INDEX IF NOT EXISTS dossier_devis_code_piece_idx
  ON public.dossier_technique_piece_devis(code_piece);

CREATE INDEX IF NOT EXISTS dossier_devis_source_official_piece_idx
  ON public.dossier_technique_piece_devis(source_official_piece_technique_id)
  WHERE source_official_piece_technique_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS article_devis_promotion_commande_idx
  ON public.article_devis_promotion(commande_id);

CREATE INDEX IF NOT EXISTS dossier_devis_promotion_commande_idx
  ON public.dossier_technique_piece_devis_promotion(commande_id);

CREATE INDEX IF NOT EXISTS commande_client_source_devis_version_idx
  ON public.commande_client(source_devis_version_id)
  WHERE source_devis_version_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS commande_ligne_source_article_devis_idx
  ON public.commande_ligne(source_article_devis_id)
  WHERE source_article_devis_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS commande_ligne_source_dossier_devis_idx
  ON public.commande_ligne(source_dossier_devis_id)
  WHERE source_dossier_devis_id IS NOT NULL;

COMMIT;
