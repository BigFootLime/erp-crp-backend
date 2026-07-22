-- Issue #164 - Article master data, traceability and lifecycle hardening.
-- Additive/idempotent patch. Apply to cerp_test only after the matching preflight.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.articles') IS NULL
     OR to_regclass('public.article_documents') IS NULL
     OR to_regclass('public.fournisseur_catalogue') IS NULL THEN
    RAISE EXCEPTION '#164 prerequisites missing: articles, article_documents and fournisseur_catalogue are required';
  END IF;
END $$;

ALTER TABLE public.articles
  ADD COLUMN IF NOT EXISTS designation_secondary text NULL,
  ADD COLUMN IF NOT EXISTS is_sold boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS row_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS archived_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS archived_by integer NULL,
  ADD COLUMN IF NOT EXISTS archive_reason text NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'articles_row_version_ck'
      AND conrelid = 'public.articles'::regclass
  ) THEN
    ALTER TABLE public.articles
      ADD CONSTRAINT articles_row_version_ck CHECK (row_version > 0);
  END IF;

  IF to_regclass('public.users') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'articles_archived_by_fkey'
      AND conrelid = 'public.articles'::regclass
  ) THEN
    ALTER TABLE public.articles
      ADD CONSTRAINT articles_archived_by_fkey
      FOREIGN KEY (archived_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS articles_archived_at_idx
  ON public.articles(archived_at)
  WHERE archived_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS articles_is_sold_idx
  ON public.articles(is_sold)
  WHERE is_sold = true;

CREATE OR REPLACE FUNCTION public.fn_articles_master_data_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.code IS DISTINCT FROM NEW.code THEN
    RAISE EXCEPTION 'ARTICLE_CODE_IMMUTABLE: Article code is immutable' USING ERRCODE = '23514';
  END IF;

  IF NEW.row_version <= OLD.row_version THEN
    NEW.row_version := OLD.row_version + 1;
  END IF;

  IF NEW.is_active = true THEN
    NEW.archived_at := NULL;
    NEW.archived_by := NULL;
    NEW.archive_reason := NULL;
  ELSIF OLD.is_active = true AND NEW.archived_at IS NULL THEN
    NEW.archived_at := now();
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_articles_master_data_guard ON public.articles;
CREATE TRIGGER trg_articles_master_data_guard
BEFORE UPDATE ON public.articles
FOR EACH ROW EXECUTE FUNCTION public.fn_articles_master_data_guard();

CREATE TABLE IF NOT EXISTS public.article_create_idempotence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  article_id uuid NOT NULL REFERENCES public.articles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT article_create_idempotence_key_uq UNIQUE (idempotency_key),
  CONSTRAINT article_create_idempotence_key_len_ck CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  CONSTRAINT article_create_idempotence_hash_ck CHECK (request_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS article_create_idempotence_article_idx
  ON public.article_create_idempotence(article_id);

CREATE TABLE IF NOT EXISTS public.article_procurement_profile (
  article_id uuid PRIMARY KEY REFERENCES public.articles(id) ON DELETE CASCADE,
  manufacturer_name text NULL,
  manufacturer_reference text NULL,
  preferred_catalogue_id uuid NULL,
  packaging text NULL,
  process text NULL,
  finish text NULL,
  requirements text NULL,
  certificate_required boolean NOT NULL DEFAULT false,
  min_stock numeric(18,3) NULL,
  max_stock numeric(18,3) NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NULL,
  updated_by integer NULL,
  CONSTRAINT article_procurement_stock_ck CHECK (
    (min_stock IS NULL OR min_stock >= 0)
    AND (max_stock IS NULL OR max_stock >= 0)
    AND (min_stock IS NULL OR max_stock IS NULL OR min_stock <= max_stock)
  )
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'article_procurement_preferred_catalogue_fkey'
      AND conrelid = 'public.article_procurement_profile'::regclass
  ) THEN
    ALTER TABLE public.article_procurement_profile
      ADD CONSTRAINT article_procurement_preferred_catalogue_fkey
      FOREIGN KEY (preferred_catalogue_id) REFERENCES public.fournisseur_catalogue(id) ON DELETE SET NULL;
  END IF;

  IF to_regclass('public.users') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'article_procurement_created_by_fkey'
      AND conrelid = 'public.article_procurement_profile'::regclass
  ) THEN
    ALTER TABLE public.article_procurement_profile
      ADD CONSTRAINT article_procurement_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;

  IF to_regclass('public.users') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'article_procurement_updated_by_fkey'
      AND conrelid = 'public.article_procurement_profile'::regclass
  ) THEN
    ALTER TABLE public.article_procurement_profile
      ADD CONSTRAINT article_procurement_updated_by_fkey
      FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS article_procurement_manufacturer_idx
  ON public.article_procurement_profile(lower(manufacturer_name))
  WHERE manufacturer_name IS NOT NULL;

ALTER TABLE public.article_documents
  ADD COLUMN IF NOT EXISTS revision text NULL,
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS retired_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS retired_by integer NULL;

DO $$
BEGIN
  IF to_regclass('public.users') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'article_documents_retired_by_fkey'
      AND conrelid = 'public.article_documents'::regclass
  ) THEN
    ALTER TABLE public.article_documents
      ADD CONSTRAINT article_documents_retired_by_fkey
      FOREIGN KEY (retired_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS article_documents_active_idx
  ON public.article_documents(article_id, is_active)
  WHERE is_active = true;

COMMIT;
