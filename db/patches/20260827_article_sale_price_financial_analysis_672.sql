-- #672 / frontend #907 / Project Office WP-252
-- Article sale-price reference, immutable provenance and customer-order snapshots.
-- Additive and idempotent. A missing price remains NULL: zero is never used as
-- a substitute for an unknown commercial or industrial value.

BEGIN;

ALTER TABLE public.articles
  ADD COLUMN IF NOT EXISTS sale_price_reference NUMERIC(18, 4) NULL,
  ADD COLUMN IF NOT EXISTS sale_price_currency VARCHAR(3) NOT NULL DEFAULT 'EUR',
  ADD COLUMN IF NOT EXISTS sale_price_source TEXT NULL,
  ADD COLUMN IF NOT EXISTS sale_price_source_entity_type TEXT NULL,
  ADD COLUMN IF NOT EXISTS sale_price_source_entity_id TEXT NULL,
  ADD COLUMN IF NOT EXISTS sale_price_updated_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS sale_price_updated_by INTEGER NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'articles_sale_price_reference_chk'
      AND conrelid = 'public.articles'::regclass
  ) THEN
    ALTER TABLE public.articles
      ADD CONSTRAINT articles_sale_price_reference_chk
      CHECK (sale_price_reference IS NULL OR sale_price_reference > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'articles_sale_price_currency_chk'
      AND conrelid = 'public.articles'::regclass
  ) THEN
    ALTER TABLE public.articles
      ADD CONSTRAINT articles_sale_price_currency_chk
      CHECK (sale_price_currency ~ '^[A-Z]{3}$');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'articles_sale_price_source_chk'
      AND conrelid = 'public.articles'::regclass
  ) THEN
    ALTER TABLE public.articles
      ADD CONSTRAINT articles_sale_price_source_chk
      CHECK (sale_price_source IS NULL OR sale_price_source IN ('ARTICLE_SHEET', 'QUOTE', 'CUSTOMER_ORDER'));
  END IF;

  IF to_regclass('public.users') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'articles_sale_price_updated_by_fkey'
      AND conrelid = 'public.articles'::regclass
  ) THEN
    ALTER TABLE public.articles
      ADD CONSTRAINT articles_sale_price_updated_by_fkey
      FOREIGN KEY (sale_price_updated_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.article_sale_price_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id UUID NOT NULL,
  previous_price NUMERIC(18, 4) NULL,
  new_price NUMERIC(18, 4) NULL,
  currency VARCHAR(3) NOT NULL DEFAULT 'EUR',
  source TEXT NOT NULL,
  source_entity_type TEXT NULL,
  source_entity_id TEXT NULL,
  decision TEXT NOT NULL,
  reason TEXT NULL,
  actor_user_id INTEGER NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT article_sale_price_history_price_chk CHECK (
    (previous_price IS NULL OR previous_price > 0)
    AND (new_price IS NULL OR new_price > 0)
  ),
  CONSTRAINT article_sale_price_history_currency_chk CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT article_sale_price_history_source_chk CHECK (
    source IN ('ARTICLE_SHEET', 'QUOTE', 'CUSTOMER_ORDER')
  ),
  CONSTRAINT article_sale_price_history_decision_chk CHECK (
    decision IN ('SET', 'OVERWRITE', 'CLEAR')
  )
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'article_sale_price_history_article_fkey'
      AND conrelid = 'public.article_sale_price_history'::regclass
  ) THEN
    ALTER TABLE public.article_sale_price_history
      ADD CONSTRAINT article_sale_price_history_article_fkey
      FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE RESTRICT;
  END IF;

  IF to_regclass('public.users') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'article_sale_price_history_actor_fkey'
      AND conrelid = 'public.article_sale_price_history'::regclass
  ) THEN
    ALTER TABLE public.article_sale_price_history
      ADD CONSTRAINT article_sale_price_history_actor_fkey
      FOREIGN KEY (actor_user_id) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS article_sale_price_history_article_created_idx
  ON public.article_sale_price_history (article_id, created_at DESC);

ALTER TABLE public.commande_ligne
  ADD COLUMN IF NOT EXISTS sale_price_reference_at_entry NUMERIC(18, 4) NULL,
  ADD COLUMN IF NOT EXISTS sale_price_reference_source TEXT NULL,
  ADD COLUMN IF NOT EXISTS sale_price_decision TEXT NOT NULL DEFAULT 'KEEP',
  ADD COLUMN IF NOT EXISTS sale_price_history_id UUID NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'commande_ligne_sale_price_reference_chk'
      AND conrelid = 'public.commande_ligne'::regclass
  ) THEN
    ALTER TABLE public.commande_ligne
      ADD CONSTRAINT commande_ligne_sale_price_reference_chk
      CHECK (sale_price_reference_at_entry IS NULL OR sale_price_reference_at_entry > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'commande_ligne_sale_price_source_chk'
      AND conrelid = 'public.commande_ligne'::regclass
  ) THEN
    ALTER TABLE public.commande_ligne
      ADD CONSTRAINT commande_ligne_sale_price_source_chk
      CHECK (sale_price_reference_source IS NULL OR sale_price_reference_source IN ('ARTICLE_SHEET', 'QUOTE', 'CUSTOMER_ORDER'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'commande_ligne_sale_price_decision_chk'
      AND conrelid = 'public.commande_ligne'::regclass
  ) THEN
    ALTER TABLE public.commande_ligne
      ADD CONSTRAINT commande_ligne_sale_price_decision_chk
      CHECK (sale_price_decision IN ('KEEP', 'SET', 'OVERWRITE'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'commande_ligne_sale_price_history_fkey'
      AND conrelid = 'public.commande_ligne'::regclass
  ) THEN
    ALTER TABLE public.commande_ligne
      ADD CONSTRAINT commande_ligne_sale_price_history_fkey
      FOREIGN KEY (sale_price_history_id) REFERENCES public.article_sale_price_history(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS commande_ligne_sale_price_history_idx
  ON public.commande_ligne (sale_price_history_id)
  WHERE sale_price_history_id IS NOT NULL;

COMMIT;
