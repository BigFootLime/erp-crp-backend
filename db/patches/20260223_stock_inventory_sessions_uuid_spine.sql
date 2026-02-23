-- Fix stock inventory sessions schema drift: use UUID masters.
-- Idempotent patch:
-- - If legacy bigint-based tables exist, they are renamed to *_legacy.
-- - New UUID-based tables are created.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.stock_inventory_lines') IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'stock_inventory_lines'
        AND column_name = 'id'
        AND data_type = 'bigint'
    )
    AND to_regclass('public.stock_inventory_lines_legacy') IS NULL
  THEN
    ALTER TABLE public.stock_inventory_lines RENAME TO stock_inventory_lines_legacy;
  END IF;

  IF to_regclass('public.stock_inventory_sessions') IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'stock_inventory_sessions'
        AND column_name = 'id'
        AND data_type = 'bigint'
    )
    AND to_regclass('public.stock_inventory_sessions_legacy') IS NULL
  THEN
    ALTER TABLE public.stock_inventory_sessions RENAME TO stock_inventory_sessions_legacy;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.stock_inventory_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_no TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN',
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ NULL,
  closed_by INTEGER NULL,
  notes TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by INTEGER NULL,
  updated_by INTEGER NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS stock_inventory_sessions_no_uniq ON public.stock_inventory_sessions (session_no);
CREATE INDEX IF NOT EXISTS stock_inventory_sessions_started_at_idx ON public.stock_inventory_sessions (started_at);
CREATE INDEX IF NOT EXISTS stock_inventory_sessions_status_idx ON public.stock_inventory_sessions (status);
CREATE INDEX IF NOT EXISTS stock_inventory_sessions_updated_at_idx ON public.stock_inventory_sessions (updated_at);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_inventory_sessions_status_check'
      AND conrelid = 'public.stock_inventory_sessions'::regclass
  ) THEN
    ALTER TABLE public.stock_inventory_sessions
      ADD CONSTRAINT stock_inventory_sessions_status_check
      CHECK (status IN ('OPEN','CLOSED'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_inventory_sessions_closed_by_fkey'
      AND conrelid = 'public.stock_inventory_sessions'::regclass
  ) THEN
    ALTER TABLE public.stock_inventory_sessions
      ADD CONSTRAINT stock_inventory_sessions_closed_by_fkey
      FOREIGN KEY (closed_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_inventory_sessions_created_by_fkey'
      AND conrelid = 'public.stock_inventory_sessions'::regclass
  ) THEN
    ALTER TABLE public.stock_inventory_sessions
      ADD CONSTRAINT stock_inventory_sessions_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_inventory_sessions_updated_by_fkey'
      AND conrelid = 'public.stock_inventory_sessions'::regclass
  ) THEN
    ALTER TABLE public.stock_inventory_sessions
      ADD CONSTRAINT stock_inventory_sessions_updated_by_fkey
      FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.stock_inventory_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL,
  line_no INTEGER NOT NULL,
  article_id UUID NOT NULL,
  magasin_id UUID NOT NULL,
  emplacement_id BIGINT NOT NULL,
  lot_id UUID NULL,
  counted_qty NUMERIC(18, 3) NOT NULL,
  note TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by INTEGER NULL,
  updated_by INTEGER NULL
);

CREATE INDEX IF NOT EXISTS stock_inventory_lines_session_idx ON public.stock_inventory_lines (session_id);
CREATE INDEX IF NOT EXISTS stock_inventory_lines_article_idx ON public.stock_inventory_lines (article_id);
CREATE INDEX IF NOT EXISTS stock_inventory_lines_emplacement_idx ON public.stock_inventory_lines (emplacement_id);

CREATE UNIQUE INDEX IF NOT EXISTS stock_inventory_lines_key_no_lot_uniq
  ON public.stock_inventory_lines (session_id, article_id, magasin_id, emplacement_id)
  WHERE lot_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS stock_inventory_lines_key_with_lot_uniq
  ON public.stock_inventory_lines (session_id, article_id, magasin_id, emplacement_id, lot_id)
  WHERE lot_id IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_inventory_lines_session_fkey'
      AND conrelid = 'public.stock_inventory_lines'::regclass
  ) THEN
    ALTER TABLE public.stock_inventory_lines
      ADD CONSTRAINT stock_inventory_lines_session_fkey
      FOREIGN KEY (session_id) REFERENCES public.stock_inventory_sessions(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_inventory_lines_article_fkey'
      AND conrelid = 'public.stock_inventory_lines'::regclass
  ) THEN
    ALTER TABLE public.stock_inventory_lines
      ADD CONSTRAINT stock_inventory_lines_article_fkey
      FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_inventory_lines_magasin_fkey'
      AND conrelid = 'public.stock_inventory_lines'::regclass
  ) THEN
    ALTER TABLE public.stock_inventory_lines
      ADD CONSTRAINT stock_inventory_lines_magasin_fkey
      FOREIGN KEY (magasin_id) REFERENCES public.magasins(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_inventory_lines_emplacement_fkey'
      AND conrelid = 'public.stock_inventory_lines'::regclass
  ) THEN
    ALTER TABLE public.stock_inventory_lines
      ADD CONSTRAINT stock_inventory_lines_emplacement_fkey
      FOREIGN KEY (emplacement_id) REFERENCES public.emplacements(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_inventory_lines_lot_fkey'
      AND conrelid = 'public.stock_inventory_lines'::regclass
  ) THEN
    ALTER TABLE public.stock_inventory_lines
      ADD CONSTRAINT stock_inventory_lines_lot_fkey
      FOREIGN KEY (lot_id) REFERENCES public.lots(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_inventory_lines_counted_qty_check'
      AND conrelid = 'public.stock_inventory_lines'::regclass
  ) THEN
    ALTER TABLE public.stock_inventory_lines
      ADD CONSTRAINT stock_inventory_lines_counted_qty_check
      CHECK (counted_qty >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_inventory_lines_created_by_fkey'
      AND conrelid = 'public.stock_inventory_lines'::regclass
  ) THEN
    ALTER TABLE public.stock_inventory_lines
      ADD CONSTRAINT stock_inventory_lines_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_inventory_lines_updated_by_fkey'
      AND conrelid = 'public.stock_inventory_lines'::regclass
  ) THEN
    ALTER TABLE public.stock_inventory_lines
      ADD CONSTRAINT stock_inventory_lines_updated_by_fkey
      FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Links an inventory session to one or more stock movements created on close.
CREATE TABLE IF NOT EXISTS public.stock_inventory_session_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL,
  stock_movement_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS stock_inventory_session_movements_unique
  ON public.stock_inventory_session_movements (session_id, stock_movement_id);

CREATE INDEX IF NOT EXISTS stock_inventory_session_movements_session_idx
  ON public.stock_inventory_session_movements (session_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_inventory_session_movements_session_fkey'
      AND conrelid = 'public.stock_inventory_session_movements'::regclass
  ) THEN
    ALTER TABLE public.stock_inventory_session_movements
      ADD CONSTRAINT stock_inventory_session_movements_session_fkey
      FOREIGN KEY (session_id) REFERENCES public.stock_inventory_sessions(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_inventory_session_movements_movement_fkey'
      AND conrelid = 'public.stock_inventory_session_movements'::regclass
  ) THEN
    ALTER TABLE public.stock_inventory_session_movements
      ADD CONSTRAINT stock_inventory_session_movements_movement_fkey
      FOREIGN KEY (stock_movement_id) REFERENCES public.stock_movements(id) ON DELETE RESTRICT;
  END IF;
END $$;

COMMIT;
