-- Stock inventory sessions (cycle counts) + adjustment posting
-- Idempotent patch: safe to run multiple times.

BEGIN;

-- Sequence used to generate human-readable inventory session numbers.
CREATE SEQUENCE IF NOT EXISTS public.stock_inventory_session_no_seq;

CREATE TABLE IF NOT EXISTS public.stock_inventory_sessions (
  id BIGSERIAL PRIMARY KEY,
  session_no TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN',
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ NULL,
  closed_by INTEGER NULL,
  adjustment_movement_id BIGINT NULL,
  notes TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by INTEGER NULL,
  updated_by INTEGER NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS stock_inventory_sessions_no_uniq ON public.stock_inventory_sessions(session_no);
CREATE INDEX IF NOT EXISTS stock_inventory_sessions_status_idx ON public.stock_inventory_sessions(status);
CREATE INDEX IF NOT EXISTS stock_inventory_sessions_started_at_idx ON public.stock_inventory_sessions(started_at);
CREATE INDEX IF NOT EXISTS stock_inventory_sessions_updated_at_idx ON public.stock_inventory_sessions(updated_at);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_inventory_sessions_status_check'
      AND conrelid = 'public.stock_inventory_sessions'::regclass
  ) THEN
    ALTER TABLE public.stock_inventory_sessions
      ADD CONSTRAINT stock_inventory_sessions_status_check
      CHECK (status IN ('OPEN', 'CLOSED'));
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

  -- Some legacy databases may have stock_movements.id as UUID; only add FK when types are compatible.
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.table_name = 'stock_movements'
      AND c.column_name = 'id'
      AND c.data_type IN ('bigint', 'integer')
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_inventory_sessions_adjustment_movement_fkey'
      AND conrelid = 'public.stock_inventory_sessions'::regclass
  ) THEN
    ALTER TABLE public.stock_inventory_sessions
      ADD CONSTRAINT stock_inventory_sessions_adjustment_movement_fkey
      FOREIGN KEY (adjustment_movement_id) REFERENCES public.stock_movements(id) ON DELETE SET NULL;
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
  id BIGSERIAL PRIMARY KEY,
  session_id BIGINT NOT NULL,
  line_no INTEGER NOT NULL,
  article_id BIGINT NOT NULL,
  magasin_id BIGINT NOT NULL,
  emplacement_id BIGINT NOT NULL,
  lot_id BIGINT NULL,
  counted_qty NUMERIC(18, 3) NOT NULL,
  note TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by INTEGER NULL,
  updated_by INTEGER NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS stock_inventory_lines_key_with_lot_uniq
  ON public.stock_inventory_lines (session_id, article_id, magasin_id, emplacement_id, lot_id)
  WHERE lot_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS stock_inventory_lines_key_no_lot_uniq
  ON public.stock_inventory_lines (session_id, article_id, magasin_id, emplacement_id)
  WHERE lot_id IS NULL;

CREATE INDEX IF NOT EXISTS stock_inventory_lines_session_idx ON public.stock_inventory_lines(session_id);
CREATE INDEX IF NOT EXISTS stock_inventory_lines_article_idx ON public.stock_inventory_lines(article_id);
CREATE INDEX IF NOT EXISTS stock_inventory_lines_emplacement_idx ON public.stock_inventory_lines(emplacement_id);

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
    IF EXISTS (
      SELECT 1
      FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name = 'articles'
        AND c.column_name = 'id'
        AND c.data_type IN ('bigint', 'integer')
    ) THEN
      ALTER TABLE public.stock_inventory_lines
        ADD CONSTRAINT stock_inventory_lines_article_fkey
        FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE RESTRICT;
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_inventory_lines_magasin_fkey'
      AND conrelid = 'public.stock_inventory_lines'::regclass
  ) THEN
    IF EXISTS (
      SELECT 1
      FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name = 'magasins'
        AND c.column_name = 'id'
        AND c.data_type IN ('bigint', 'integer')
    ) THEN
      ALTER TABLE public.stock_inventory_lines
        ADD CONSTRAINT stock_inventory_lines_magasin_fkey
        FOREIGN KEY (magasin_id) REFERENCES public.magasins(id) ON DELETE RESTRICT;
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_inventory_lines_emplacement_fkey'
      AND conrelid = 'public.stock_inventory_lines'::regclass
  ) THEN
    IF EXISTS (
      SELECT 1
      FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name = 'emplacements'
        AND c.column_name = 'id'
        AND c.data_type IN ('bigint', 'integer')
    ) THEN
      ALTER TABLE public.stock_inventory_lines
        ADD CONSTRAINT stock_inventory_lines_emplacement_fkey
        FOREIGN KEY (emplacement_id) REFERENCES public.emplacements(id) ON DELETE RESTRICT;
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_inventory_lines_lot_fkey'
      AND conrelid = 'public.stock_inventory_lines'::regclass
  ) THEN
    IF EXISTS (
      SELECT 1
      FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name = 'lots'
        AND c.column_name = 'id'
        AND c.data_type IN ('bigint', 'integer')
    ) THEN
      ALTER TABLE public.stock_inventory_lines
        ADD CONSTRAINT stock_inventory_lines_lot_fkey
        FOREIGN KEY (lot_id) REFERENCES public.lots(id) ON DELETE SET NULL;
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_inventory_lines_lot_article_fkey'
      AND conrelid = 'public.stock_inventory_lines'::regclass
  ) THEN
    IF EXISTS (
      SELECT 1
      FROM information_schema.columns c1
      WHERE c1.table_schema = 'public'
        AND c1.table_name = 'lots'
        AND c1.column_name = 'id'
        AND c1.data_type IN ('bigint', 'integer')
    ) AND EXISTS (
      SELECT 1
      FROM information_schema.columns c2
      WHERE c2.table_schema = 'public'
        AND c2.table_name = 'lots'
        AND c2.column_name = 'article_id'
        AND c2.data_type IN ('bigint', 'integer')
    ) THEN
      ALTER TABLE public.stock_inventory_lines
        ADD CONSTRAINT stock_inventory_lines_lot_article_fkey
        FOREIGN KEY (lot_id, article_id) REFERENCES public.lots(id, article_id) ON DELETE SET NULL;
    END IF;
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

COMMIT;
