-- Phase 3: Commandes -> auto-affaires generation
-- - Stock reservations persistence (stock_levels.qty_reserved)
-- - Commande domain event log
-- Idempotent patch: safe to run multiple times.

BEGIN;

/* -------------------------------------------------------------------------- */
/* 1) Stock reservations                                                       */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.stock_reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id UUID NOT NULL,
  location_id UUID NOT NULL,
  qty_reserved NUMERIC(12, 3) NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by INTEGER NULL,
  updated_by INTEGER NULL
);

CREATE INDEX IF NOT EXISTS stock_reservations_article_idx
  ON public.stock_reservations (article_id);

CREATE INDEX IF NOT EXISTS stock_reservations_location_idx
  ON public.stock_reservations (location_id);

CREATE INDEX IF NOT EXISTS stock_reservations_source_idx
  ON public.stock_reservations (source_type, source_id);

CREATE INDEX IF NOT EXISTS stock_reservations_status_idx
  ON public.stock_reservations (status);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_reservations_qty_check'
      AND conrelid = 'public.stock_reservations'::regclass
  ) THEN
    ALTER TABLE public.stock_reservations
      ADD CONSTRAINT stock_reservations_qty_check
      CHECK (qty_reserved > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_reservations_article_fkey'
      AND conrelid = 'public.stock_reservations'::regclass
  ) THEN
    ALTER TABLE public.stock_reservations
      ADD CONSTRAINT stock_reservations_article_fkey
      FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_reservations_location_fkey'
      AND conrelid = 'public.stock_reservations'::regclass
  ) THEN
    ALTER TABLE public.stock_reservations
      ADD CONSTRAINT stock_reservations_location_fkey
      FOREIGN KEY (location_id) REFERENCES public.locations(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_reservations_created_by_fkey'
      AND conrelid = 'public.stock_reservations'::regclass
  ) THEN
    ALTER TABLE public.stock_reservations
      ADD CONSTRAINT stock_reservations_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_reservations_updated_by_fkey'
      AND conrelid = 'public.stock_reservations'::regclass
  ) THEN
    ALTER TABLE public.stock_reservations
      ADD CONSTRAINT stock_reservations_updated_by_fkey
      FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $$;

/* -------------------------------------------------------------------------- */
/* 2) Commande domain event log                                                */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.commande_client_event_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  commande_id BIGINT NOT NULL,
  event_type TEXT NOT NULL,
  old_values JSONB NULL,
  new_values JSONB NULL,
  user_id INTEGER NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS commande_client_event_log_commande_idx
  ON public.commande_client_event_log (commande_id);

CREATE INDEX IF NOT EXISTS commande_client_event_log_created_at_idx
  ON public.commande_client_event_log (created_at);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'commande_client_event_log_commande_fkey'
      AND conrelid = 'public.commande_client_event_log'::regclass
  ) THEN
    ALTER TABLE public.commande_client_event_log
      ADD CONSTRAINT commande_client_event_log_commande_fkey
      FOREIGN KEY (commande_id) REFERENCES public.commande_client(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'commande_client_event_log_user_fkey'
      AND conrelid = 'public.commande_client_event_log'::regclass
  ) THEN
    ALTER TABLE public.commande_client_event_log
      ADD CONSTRAINT commande_client_event_log_user_fkey
      FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $$;

COMMIT;
