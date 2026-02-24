-- Livraisons shipment allocations + deterministic shipping location setting.
-- Idempotent patch: safe to run multiple times.

BEGIN;

/* -------------------------------------------------------------------------- */
/* 1) Generic ERP settings (key/value)                                         */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.erp_settings (
  key TEXT PRIMARY KEY,
  value_text TEXT NULL,
  value_json JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by INTEGER NULL,
  updated_by INTEGER NULL
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'erp_settings_created_by_fkey'
      AND conrelid = 'public.erp_settings'::regclass
  ) THEN
    ALTER TABLE public.erp_settings
      ADD CONSTRAINT erp_settings_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'erp_settings_updated_by_fkey'
      AND conrelid = 'public.erp_settings'::regclass
  ) THEN
    ALTER TABLE public.erp_settings
      ADD CONSTRAINT erp_settings_updated_by_fkey
      FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $$;

/* -------------------------------------------------------------------------- */
/* 2) Livraison line allocations (article/lot traceability)                    */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.bon_livraison_ligne_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bon_livraison_ligne_id UUID NOT NULL,
  article_id UUID NOT NULL,
  lot_id UUID NULL,
  stock_movement_line_id UUID NULL,
  quantite NUMERIC(12, 3) NOT NULL,
  unite TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by INTEGER NULL,
  updated_by INTEGER NULL
);

CREATE INDEX IF NOT EXISTS bon_livraison_ligne_allocations_ligne_idx
  ON public.bon_livraison_ligne_allocations (bon_livraison_ligne_id);

CREATE INDEX IF NOT EXISTS bon_livraison_ligne_allocations_article_idx
  ON public.bon_livraison_ligne_allocations (article_id);

CREATE INDEX IF NOT EXISTS bon_livraison_ligne_allocations_lot_idx
  ON public.bon_livraison_ligne_allocations (lot_id);

CREATE INDEX IF NOT EXISTS bon_livraison_ligne_allocations_stock_movement_line_idx
  ON public.bon_livraison_ligne_allocations (stock_movement_line_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bon_livraison_ligne_allocations_qty_check'
      AND conrelid = 'public.bon_livraison_ligne_allocations'::regclass
  ) THEN
    ALTER TABLE public.bon_livraison_ligne_allocations
      ADD CONSTRAINT bon_livraison_ligne_allocations_qty_check
      CHECK (quantite > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bon_livraison_ligne_allocations_ligne_fkey'
      AND conrelid = 'public.bon_livraison_ligne_allocations'::regclass
  ) THEN
    ALTER TABLE public.bon_livraison_ligne_allocations
      ADD CONSTRAINT bon_livraison_ligne_allocations_ligne_fkey
      FOREIGN KEY (bon_livraison_ligne_id) REFERENCES public.bon_livraison_ligne(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bon_livraison_ligne_allocations_article_fkey'
      AND conrelid = 'public.bon_livraison_ligne_allocations'::regclass
  ) THEN
    ALTER TABLE public.bon_livraison_ligne_allocations
      ADD CONSTRAINT bon_livraison_ligne_allocations_article_fkey
      FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bon_livraison_ligne_allocations_lot_fkey'
      AND conrelid = 'public.bon_livraison_ligne_allocations'::regclass
  ) THEN
    ALTER TABLE public.bon_livraison_ligne_allocations
      ADD CONSTRAINT bon_livraison_ligne_allocations_lot_fkey
      FOREIGN KEY (lot_id) REFERENCES public.lots(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bon_livraison_ligne_allocations_stock_movement_line_fkey'
      AND conrelid = 'public.bon_livraison_ligne_allocations'::regclass
  ) THEN
    ALTER TABLE public.bon_livraison_ligne_allocations
      ADD CONSTRAINT bon_livraison_ligne_allocations_stock_movement_line_fkey
      FOREIGN KEY (stock_movement_line_id) REFERENCES public.stock_movement_lines(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bon_livraison_ligne_allocations_created_by_fkey'
      AND conrelid = 'public.bon_livraison_ligne_allocations'::regclass
  ) THEN
    ALTER TABLE public.bon_livraison_ligne_allocations
      ADD CONSTRAINT bon_livraison_ligne_allocations_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bon_livraison_ligne_allocations_updated_by_fkey'
      AND conrelid = 'public.bon_livraison_ligne_allocations'::regclass
  ) THEN
    ALTER TABLE public.bon_livraison_ligne_allocations
      ADD CONSTRAINT bon_livraison_ligne_allocations_updated_by_fkey
      FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $$;

COMMIT;
