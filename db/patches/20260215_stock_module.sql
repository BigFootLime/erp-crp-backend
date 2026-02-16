-- Stock module (Articles, Magasins, Lots, Mouvements, Ledger)
-- Idempotent patch: safe to run multiple times.

BEGIN;

-- Sequence used to generate human-readable movement numbers.
CREATE SEQUENCE IF NOT EXISTS public.stock_movement_no_seq;

/* -------------------------------------------------------------------------- */
/* 1) Master data                                                             */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.articles (
  id BIGSERIAL PRIMARY KEY,
  code TEXT NOT NULL,
  designation TEXT NOT NULL,
  article_type TEXT NOT NULL DEFAULT 'PURCHASED',
  piece_technique_id UUID NULL,
  unite TEXT NULL,
  lot_tracking BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  notes TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by INTEGER NULL,
  updated_by INTEGER NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS articles_code_uniq ON public.articles (code);
CREATE INDEX IF NOT EXISTS articles_updated_at_idx ON public.articles (updated_at);
CREATE INDEX IF NOT EXISTS articles_is_active_idx ON public.articles (is_active);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'articles_article_type_check'
      AND conrelid = 'public.articles'::regclass
  ) THEN
    ALTER TABLE public.articles
      ADD CONSTRAINT articles_article_type_check
      CHECK (article_type IN ('PIECE_TECHNIQUE', 'PURCHASED'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'articles_created_by_fkey'
      AND conrelid = 'public.articles'::regclass
  ) THEN
    ALTER TABLE public.articles
      ADD CONSTRAINT articles_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'articles_updated_by_fkey'
      AND conrelid = 'public.articles'::regclass
  ) THEN
    ALTER TABLE public.articles
      ADD CONSTRAINT articles_updated_by_fkey
      FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;

  IF to_regclass('public.pieces_techniques') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'articles_piece_technique_id_fkey'
      AND conrelid = 'public.articles'::regclass
  ) THEN
    ALTER TABLE public.articles
      ADD CONSTRAINT articles_piece_technique_id_fkey
      FOREIGN KEY (piece_technique_id) REFERENCES public.pieces_techniques(id) ON DELETE SET NULL;
  END IF;
END $$;


CREATE TABLE IF NOT EXISTS public.magasins (
  id BIGSERIAL PRIMARY KEY,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  notes TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by INTEGER NULL,
  updated_by INTEGER NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS magasins_code_uniq ON public.magasins (code);
CREATE INDEX IF NOT EXISTS magasins_updated_at_idx ON public.magasins (updated_at);
CREATE INDEX IF NOT EXISTS magasins_is_active_idx ON public.magasins (is_active);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'magasins_created_by_fkey'
      AND conrelid = 'public.magasins'::regclass
  ) THEN
    ALTER TABLE public.magasins
      ADD CONSTRAINT magasins_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'magasins_updated_by_fkey'
      AND conrelid = 'public.magasins'::regclass
  ) THEN
    ALTER TABLE public.magasins
      ADD CONSTRAINT magasins_updated_by_fkey
      FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $$;


CREATE TABLE IF NOT EXISTS public.emplacements (
  id BIGSERIAL PRIMARY KEY,
  magasin_id BIGINT NOT NULL,
  code TEXT NOT NULL,
  name TEXT NULL,
  is_scrap BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  notes TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by INTEGER NULL,
  updated_by INTEGER NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS emplacements_magasin_code_uniq ON public.emplacements (magasin_id, code);
CREATE INDEX IF NOT EXISTS emplacements_magasin_idx ON public.emplacements (magasin_id);
CREATE INDEX IF NOT EXISTS emplacements_updated_at_idx ON public.emplacements (updated_at);
CREATE INDEX IF NOT EXISTS emplacements_is_active_idx ON public.emplacements (is_active);
CREATE INDEX IF NOT EXISTS emplacements_is_scrap_idx ON public.emplacements (is_scrap);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'emplacements_magasin_id_fkey'
      AND conrelid = 'public.emplacements'::regclass
  ) THEN
    ALTER TABLE public.emplacements
      ADD CONSTRAINT emplacements_magasin_id_fkey
      FOREIGN KEY (magasin_id) REFERENCES public.magasins(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'emplacements_created_by_fkey'
      AND conrelid = 'public.emplacements'::regclass
  ) THEN
    ALTER TABLE public.emplacements
      ADD CONSTRAINT emplacements_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'emplacements_updated_by_fkey'
      AND conrelid = 'public.emplacements'::regclass
  ) THEN
    ALTER TABLE public.emplacements
      ADD CONSTRAINT emplacements_updated_by_fkey
      FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $$;


CREATE TABLE IF NOT EXISTS public.lots (
  id BIGSERIAL PRIMARY KEY,
  article_id BIGINT NOT NULL,
  lot_code TEXT NOT NULL,
  supplier_lot_code TEXT NULL,
  received_at DATE NULL,
  manufactured_at DATE NULL,
  expiry_at DATE NULL,
  notes TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by INTEGER NULL,
  updated_by INTEGER NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS lots_article_lot_code_uniq ON public.lots (article_id, lot_code);
CREATE UNIQUE INDEX IF NOT EXISTS lots_id_article_uniq ON public.lots (id, article_id);
CREATE INDEX IF NOT EXISTS lots_article_idx ON public.lots (article_id);
CREATE INDEX IF NOT EXISTS lots_updated_at_idx ON public.lots (updated_at);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'lots_article_id_fkey'
      AND conrelid = 'public.lots'::regclass
  ) THEN
    ALTER TABLE public.lots
      ADD CONSTRAINT lots_article_id_fkey
      FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'lots_created_by_fkey'
      AND conrelid = 'public.lots'::regclass
  ) THEN
    ALTER TABLE public.lots
      ADD CONSTRAINT lots_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'lots_updated_by_fkey'
      AND conrelid = 'public.lots'::regclass
  ) THEN
    ALTER TABLE public.lots
      ADD CONSTRAINT lots_updated_by_fkey
      FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $$;


/* -------------------------------------------------------------------------- */
/* 2) Movements                                                               */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.stock_movements (
  id BIGSERIAL PRIMARY KEY,
  movement_no TEXT NOT NULL,
  movement_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  effective_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  posted_at TIMESTAMPTZ NULL,
  posted_by INTEGER NULL,
  source_document_type TEXT NULL,
  source_document_id TEXT NULL,
  reason_code TEXT NULL,
  notes TEXT NULL,
  idempotency_key TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by INTEGER NULL,
  updated_by INTEGER NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS stock_movements_no_uniq ON public.stock_movements (movement_no);
CREATE UNIQUE INDEX IF NOT EXISTS stock_movements_idempotency_uniq ON public.stock_movements (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS stock_movements_type_idx ON public.stock_movements (movement_type);
CREATE INDEX IF NOT EXISTS stock_movements_status_idx ON public.stock_movements (status);
CREATE INDEX IF NOT EXISTS stock_movements_effective_at_idx ON public.stock_movements (effective_at);
CREATE INDEX IF NOT EXISTS stock_movements_updated_at_idx ON public.stock_movements (updated_at);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_movements_type_check'
      AND conrelid = 'public.stock_movements'::regclass
  ) THEN
    ALTER TABLE public.stock_movements
      ADD CONSTRAINT stock_movements_type_check
      CHECK (movement_type IN ('IN', 'OUT', 'TRANSFER', 'ADJUSTMENT', 'SCRAP'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_movements_status_check'
      AND conrelid = 'public.stock_movements'::regclass
  ) THEN
    ALTER TABLE public.stock_movements
      ADD CONSTRAINT stock_movements_status_check
      CHECK (status IN ('DRAFT', 'POSTED', 'CANCELLED'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_movements_posted_at_check'
      AND conrelid = 'public.stock_movements'::regclass
  ) THEN
    ALTER TABLE public.stock_movements
      ADD CONSTRAINT stock_movements_posted_at_check
      CHECK ((status <> 'POSTED') OR (posted_at IS NOT NULL));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_movements_created_by_fkey'
      AND conrelid = 'public.stock_movements'::regclass
  ) THEN
    ALTER TABLE public.stock_movements
      ADD CONSTRAINT stock_movements_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_movements_updated_by_fkey'
      AND conrelid = 'public.stock_movements'::regclass
  ) THEN
    ALTER TABLE public.stock_movements
      ADD CONSTRAINT stock_movements_updated_by_fkey
      FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_movements_posted_by_fkey'
      AND conrelid = 'public.stock_movements'::regclass
  ) THEN
    ALTER TABLE public.stock_movements
      ADD CONSTRAINT stock_movements_posted_by_fkey
      FOREIGN KEY (posted_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $$;


CREATE TABLE IF NOT EXISTS public.stock_movement_lines (
  id BIGSERIAL PRIMARY KEY,
  movement_id BIGINT NOT NULL,
  line_no INTEGER NOT NULL DEFAULT 1,
  article_id BIGINT NOT NULL,
  lot_id BIGINT NULL,
  qty NUMERIC(18, 3) NOT NULL,
  unite TEXT NULL,
  unit_cost NUMERIC(18, 6) NULL,
  currency TEXT NULL,
  src_magasin_id BIGINT NULL,
  src_emplacement_id BIGINT NULL,
  dst_magasin_id BIGINT NULL,
  dst_emplacement_id BIGINT NULL,
  note TEXT NULL,
  direction TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by INTEGER NULL,
  updated_by INTEGER NULL
);

ALTER TABLE public.stock_movement_lines
  ADD COLUMN IF NOT EXISTS direction TEXT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS stock_movement_lines_unique_line
  ON public.stock_movement_lines (movement_id, line_no);

CREATE INDEX IF NOT EXISTS stock_movement_lines_movement_idx ON public.stock_movement_lines (movement_id);
CREATE INDEX IF NOT EXISTS stock_movement_lines_article_idx ON public.stock_movement_lines (article_id);
CREATE INDEX IF NOT EXISTS stock_movement_lines_lot_idx ON public.stock_movement_lines (lot_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_movement_lines_movement_id_fkey'
      AND conrelid = 'public.stock_movement_lines'::regclass
  ) THEN
    ALTER TABLE public.stock_movement_lines
      ADD CONSTRAINT stock_movement_lines_movement_id_fkey
      FOREIGN KEY (movement_id) REFERENCES public.stock_movements(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_movement_lines_article_id_fkey'
      AND conrelid = 'public.stock_movement_lines'::regclass
  ) THEN
    ALTER TABLE public.stock_movement_lines
      ADD CONSTRAINT stock_movement_lines_article_id_fkey
      FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_movement_lines_lot_id_fkey'
      AND conrelid = 'public.stock_movement_lines'::regclass
  ) THEN
    ALTER TABLE public.stock_movement_lines
      ADD CONSTRAINT stock_movement_lines_lot_id_fkey
      FOREIGN KEY (lot_id) REFERENCES public.lots(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_movement_lines_lot_article_fkey'
      AND conrelid = 'public.stock_movement_lines'::regclass
  ) THEN
    ALTER TABLE public.stock_movement_lines
      ADD CONSTRAINT stock_movement_lines_lot_article_fkey
      FOREIGN KEY (lot_id, article_id) REFERENCES public.lots(id, article_id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_movement_lines_src_magasin_id_fkey'
      AND conrelid = 'public.stock_movement_lines'::regclass
  ) THEN
    ALTER TABLE public.stock_movement_lines
      ADD CONSTRAINT stock_movement_lines_src_magasin_id_fkey
      FOREIGN KEY (src_magasin_id) REFERENCES public.magasins(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_movement_lines_dst_magasin_id_fkey'
      AND conrelid = 'public.stock_movement_lines'::regclass
  ) THEN
    ALTER TABLE public.stock_movement_lines
      ADD CONSTRAINT stock_movement_lines_dst_magasin_id_fkey
      FOREIGN KEY (dst_magasin_id) REFERENCES public.magasins(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_movement_lines_src_emplacement_id_fkey'
      AND conrelid = 'public.stock_movement_lines'::regclass
  ) THEN
    ALTER TABLE public.stock_movement_lines
      ADD CONSTRAINT stock_movement_lines_src_emplacement_id_fkey
      FOREIGN KEY (src_emplacement_id) REFERENCES public.emplacements(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_movement_lines_dst_emplacement_id_fkey'
      AND conrelid = 'public.stock_movement_lines'::regclass
  ) THEN
    ALTER TABLE public.stock_movement_lines
      ADD CONSTRAINT stock_movement_lines_dst_emplacement_id_fkey
      FOREIGN KEY (dst_emplacement_id) REFERENCES public.emplacements(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_movement_lines_qty_check'
      AND conrelid = 'public.stock_movement_lines'::regclass
  ) THEN
    ALTER TABLE public.stock_movement_lines
      ADD CONSTRAINT stock_movement_lines_qty_check
      CHECK (qty > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_movement_lines_direction_check'
      AND conrelid = 'public.stock_movement_lines'::regclass
  ) THEN
    ALTER TABLE public.stock_movement_lines
      ADD CONSTRAINT stock_movement_lines_direction_check
      CHECK (direction IS NULL OR direction IN ('IN', 'OUT'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_movement_lines_created_by_fkey'
      AND conrelid = 'public.stock_movement_lines'::regclass
  ) THEN
    ALTER TABLE public.stock_movement_lines
      ADD CONSTRAINT stock_movement_lines_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_movement_lines_updated_by_fkey'
      AND conrelid = 'public.stock_movement_lines'::regclass
  ) THEN
    ALTER TABLE public.stock_movement_lines
      ADD CONSTRAINT stock_movement_lines_updated_by_fkey
      FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $$;


/* -------------------------------------------------------------------------- */
/* 3) Ledger + balances                                                       */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.stock_ledger (
  id BIGSERIAL PRIMARY KEY,
  movement_id BIGINT NOT NULL,
  movement_line_id BIGINT NOT NULL,
  leg_no SMALLINT NOT NULL DEFAULT 1,
  article_id BIGINT NOT NULL,
  magasin_id BIGINT NOT NULL,
  emplacement_id BIGINT NOT NULL,
  lot_id BIGINT NULL,
  delta_qty NUMERIC(18, 3) NOT NULL,
  qty_before NUMERIC(18, 3) NOT NULL,
  qty_after NUMERIC(18, 3) NOT NULL,
  effective_at TIMESTAMPTZ NOT NULL,
  posted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reversal_of_id BIGINT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by INTEGER NULL,
  updated_by INTEGER NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS stock_ledger_unique_leg
  ON public.stock_ledger (movement_id, movement_line_id, leg_no);

CREATE INDEX IF NOT EXISTS stock_ledger_movement_idx ON public.stock_ledger (movement_id);
CREATE INDEX IF NOT EXISTS stock_ledger_line_idx ON public.stock_ledger (movement_line_id);
CREATE INDEX IF NOT EXISTS stock_ledger_key_time_idx
  ON public.stock_ledger (article_id, magasin_id, emplacement_id, lot_id, posted_at DESC, id DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_ledger_movement_id_fkey'
      AND conrelid = 'public.stock_ledger'::regclass
  ) THEN
    ALTER TABLE public.stock_ledger
      ADD CONSTRAINT stock_ledger_movement_id_fkey
      FOREIGN KEY (movement_id) REFERENCES public.stock_movements(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_ledger_movement_line_id_fkey'
      AND conrelid = 'public.stock_ledger'::regclass
  ) THEN
    ALTER TABLE public.stock_ledger
      ADD CONSTRAINT stock_ledger_movement_line_id_fkey
      FOREIGN KEY (movement_line_id) REFERENCES public.stock_movement_lines(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_ledger_article_id_fkey'
      AND conrelid = 'public.stock_ledger'::regclass
  ) THEN
    ALTER TABLE public.stock_ledger
      ADD CONSTRAINT stock_ledger_article_id_fkey
      FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_ledger_magasin_id_fkey'
      AND conrelid = 'public.stock_ledger'::regclass
  ) THEN
    ALTER TABLE public.stock_ledger
      ADD CONSTRAINT stock_ledger_magasin_id_fkey
      FOREIGN KEY (magasin_id) REFERENCES public.magasins(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_ledger_emplacement_id_fkey'
      AND conrelid = 'public.stock_ledger'::regclass
  ) THEN
    ALTER TABLE public.stock_ledger
      ADD CONSTRAINT stock_ledger_emplacement_id_fkey
      FOREIGN KEY (emplacement_id) REFERENCES public.emplacements(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_ledger_lot_id_fkey'
      AND conrelid = 'public.stock_ledger'::regclass
  ) THEN
    ALTER TABLE public.stock_ledger
      ADD CONSTRAINT stock_ledger_lot_id_fkey
      FOREIGN KEY (lot_id) REFERENCES public.lots(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_ledger_lot_article_fkey'
      AND conrelid = 'public.stock_ledger'::regclass
  ) THEN
    ALTER TABLE public.stock_ledger
      ADD CONSTRAINT stock_ledger_lot_article_fkey
      FOREIGN KEY (lot_id, article_id) REFERENCES public.lots(id, article_id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_ledger_reversal_of_id_fkey'
      AND conrelid = 'public.stock_ledger'::regclass
  ) THEN
    ALTER TABLE public.stock_ledger
      ADD CONSTRAINT stock_ledger_reversal_of_id_fkey
      FOREIGN KEY (reversal_of_id) REFERENCES public.stock_ledger(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_ledger_qty_after_check'
      AND conrelid = 'public.stock_ledger'::regclass
  ) THEN
    ALTER TABLE public.stock_ledger
      ADD CONSTRAINT stock_ledger_qty_after_check
      CHECK (qty_after >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_ledger_delta_qty_check'
      AND conrelid = 'public.stock_ledger'::regclass
  ) THEN
    ALTER TABLE public.stock_ledger
      ADD CONSTRAINT stock_ledger_delta_qty_check
      CHECK (delta_qty <> 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_ledger_created_by_fkey'
      AND conrelid = 'public.stock_ledger'::regclass
  ) THEN
    ALTER TABLE public.stock_ledger
      ADD CONSTRAINT stock_ledger_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_ledger_updated_by_fkey'
      AND conrelid = 'public.stock_ledger'::regclass
  ) THEN
    ALTER TABLE public.stock_ledger
      ADD CONSTRAINT stock_ledger_updated_by_fkey
      FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $$;


CREATE TABLE IF NOT EXISTS public.stock_balances (
  id BIGSERIAL PRIMARY KEY,
  article_id BIGINT NOT NULL,
  magasin_id BIGINT NOT NULL,
  emplacement_id BIGINT NOT NULL,
  lot_id BIGINT NULL,
  qty_on_hand NUMERIC(18, 3) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by INTEGER NULL,
  updated_by INTEGER NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS stock_balances_key_with_lot_uniq
  ON public.stock_balances (article_id, magasin_id, emplacement_id, lot_id)
  WHERE lot_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS stock_balances_key_no_lot_uniq
  ON public.stock_balances (article_id, magasin_id, emplacement_id)
  WHERE lot_id IS NULL;

CREATE INDEX IF NOT EXISTS stock_balances_article_idx ON public.stock_balances (article_id);
CREATE INDEX IF NOT EXISTS stock_balances_magasin_idx ON public.stock_balances (magasin_id);
CREATE INDEX IF NOT EXISTS stock_balances_emplacement_idx ON public.stock_balances (emplacement_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_balances_article_id_fkey'
      AND conrelid = 'public.stock_balances'::regclass
  ) THEN
    ALTER TABLE public.stock_balances
      ADD CONSTRAINT stock_balances_article_id_fkey
      FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_balances_magasin_id_fkey'
      AND conrelid = 'public.stock_balances'::regclass
  ) THEN
    ALTER TABLE public.stock_balances
      ADD CONSTRAINT stock_balances_magasin_id_fkey
      FOREIGN KEY (magasin_id) REFERENCES public.magasins(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_balances_emplacement_id_fkey'
      AND conrelid = 'public.stock_balances'::regclass
  ) THEN
    ALTER TABLE public.stock_balances
      ADD CONSTRAINT stock_balances_emplacement_id_fkey
      FOREIGN KEY (emplacement_id) REFERENCES public.emplacements(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_balances_lot_id_fkey'
      AND conrelid = 'public.stock_balances'::regclass
  ) THEN
    ALTER TABLE public.stock_balances
      ADD CONSTRAINT stock_balances_lot_id_fkey
      FOREIGN KEY (lot_id) REFERENCES public.lots(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_balances_lot_article_fkey'
      AND conrelid = 'public.stock_balances'::regclass
  ) THEN
    ALTER TABLE public.stock_balances
      ADD CONSTRAINT stock_balances_lot_article_fkey
      FOREIGN KEY (lot_id, article_id) REFERENCES public.lots(id, article_id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_balances_qty_on_hand_check'
      AND conrelid = 'public.stock_balances'::regclass
  ) THEN
    ALTER TABLE public.stock_balances
      ADD CONSTRAINT stock_balances_qty_on_hand_check
      CHECK (qty_on_hand >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_balances_created_by_fkey'
      AND conrelid = 'public.stock_balances'::regclass
  ) THEN
    ALTER TABLE public.stock_balances
      ADD CONSTRAINT stock_balances_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_balances_updated_by_fkey'
      AND conrelid = 'public.stock_balances'::regclass
  ) THEN
    ALTER TABLE public.stock_balances
      ADD CONSTRAINT stock_balances_updated_by_fkey
      FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $$;


/* -------------------------------------------------------------------------- */
/* 4) Documents + event log                                                   */
/* -------------------------------------------------------------------------- */

-- Dedicated documents table for stock module (keeps module self-contained).
CREATE TABLE IF NOT EXISTS public.stock_documents (
  id UUID PRIMARY KEY,
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  sha256 TEXT NULL,
  label TEXT NULL,
  uploaded_by INTEGER NULL,
  removed_at TIMESTAMPTZ NULL,
  removed_by INTEGER NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by INTEGER NULL,
  updated_by INTEGER NULL
);

CREATE INDEX IF NOT EXISTS stock_documents_created_at_idx ON public.stock_documents(created_at);
CREATE INDEX IF NOT EXISTS stock_documents_removed_at_idx ON public.stock_documents(removed_at);
CREATE INDEX IF NOT EXISTS stock_documents_sha256_idx ON public.stock_documents(sha256);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'stock_documents_uploaded_by_fkey'
  ) THEN
    ALTER TABLE public.stock_documents
      ADD CONSTRAINT stock_documents_uploaded_by_fkey
      FOREIGN KEY (uploaded_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'stock_documents_created_by_fkey'
  ) THEN
    ALTER TABLE public.stock_documents
      ADD CONSTRAINT stock_documents_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'stock_documents_updated_by_fkey'
  ) THEN
    ALTER TABLE public.stock_documents
      ADD CONSTRAINT stock_documents_updated_by_fkey
      FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'stock_documents_removed_by_fkey'
  ) THEN
    ALTER TABLE public.stock_documents
      ADD CONSTRAINT stock_documents_removed_by_fkey
      FOREIGN KEY (removed_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.stock_movement_documents (
  id BIGSERIAL PRIMARY KEY,
  stock_movement_id BIGINT NOT NULL,
  document_id UUID NOT NULL,
  type TEXT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  uploaded_by INTEGER NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by INTEGER NULL,
  updated_by INTEGER NULL
);

ALTER TABLE public.stock_movement_documents
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE public.stock_movement_documents
  ADD COLUMN IF NOT EXISTS created_by INTEGER NULL;
ALTER TABLE public.stock_movement_documents
  ADD COLUMN IF NOT EXISTS updated_by INTEGER NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'stock_movement_documents_movement_fkey'
  ) THEN
    ALTER TABLE public.stock_movement_documents
      ADD CONSTRAINT stock_movement_documents_movement_fkey
      FOREIGN KEY (stock_movement_id) REFERENCES public.stock_movements(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'stock_movement_documents_stock_document_fkey'
  ) THEN
    ALTER TABLE public.stock_movement_documents
      ADD CONSTRAINT stock_movement_documents_stock_document_fkey
      FOREIGN KEY (document_id) REFERENCES public.stock_documents(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'stock_movement_documents_uploaded_by_fkey'
  ) THEN
    ALTER TABLE public.stock_movement_documents
      ADD CONSTRAINT stock_movement_documents_uploaded_by_fkey
      FOREIGN KEY (uploaded_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'stock_movement_documents_created_by_fkey'
  ) THEN
    ALTER TABLE public.stock_movement_documents
      ADD CONSTRAINT stock_movement_documents_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'stock_movement_documents_updated_by_fkey'
  ) THEN
    ALTER TABLE public.stock_movement_documents
      ADD CONSTRAINT stock_movement_documents_updated_by_fkey
      FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'stock_movement_documents_unique_doc'
  ) THEN
    ALTER TABLE public.stock_movement_documents
      ADD CONSTRAINT stock_movement_documents_unique_doc UNIQUE (stock_movement_id, document_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS stock_movement_documents_movement_idx ON public.stock_movement_documents(stock_movement_id);
CREATE INDEX IF NOT EXISTS stock_movement_documents_created_at_idx ON public.stock_movement_documents(created_at);
CREATE INDEX IF NOT EXISTS stock_movement_documents_type_idx ON public.stock_movement_documents(type);


CREATE TABLE IF NOT EXISTS public.article_documents (
  id BIGSERIAL PRIMARY KEY,
  article_id BIGINT NOT NULL,
  document_id UUID NOT NULL,
  type TEXT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  uploaded_by INTEGER NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by INTEGER NULL,
  updated_by INTEGER NULL
);

ALTER TABLE public.article_documents
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE public.article_documents
  ADD COLUMN IF NOT EXISTS created_by INTEGER NULL;
ALTER TABLE public.article_documents
  ADD COLUMN IF NOT EXISTS updated_by INTEGER NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'article_documents_article_fkey'
  ) THEN
    ALTER TABLE public.article_documents
      ADD CONSTRAINT article_documents_article_fkey
      FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'article_documents_stock_document_fkey'
  ) THEN
    ALTER TABLE public.article_documents
      ADD CONSTRAINT article_documents_stock_document_fkey
      FOREIGN KEY (document_id) REFERENCES public.stock_documents(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'article_documents_uploaded_by_fkey'
  ) THEN
    ALTER TABLE public.article_documents
      ADD CONSTRAINT article_documents_uploaded_by_fkey
      FOREIGN KEY (uploaded_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'article_documents_created_by_fkey'
  ) THEN
    ALTER TABLE public.article_documents
      ADD CONSTRAINT article_documents_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'article_documents_updated_by_fkey'
  ) THEN
    ALTER TABLE public.article_documents
      ADD CONSTRAINT article_documents_updated_by_fkey
      FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'article_documents_unique_doc'
  ) THEN
    ALTER TABLE public.article_documents
      ADD CONSTRAINT article_documents_unique_doc UNIQUE (article_id, document_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS article_documents_article_idx ON public.article_documents(article_id);
CREATE INDEX IF NOT EXISTS article_documents_created_at_idx ON public.article_documents(created_at);
CREATE INDEX IF NOT EXISTS article_documents_type_idx ON public.article_documents(type);


CREATE TABLE IF NOT EXISTS public.stock_movement_event_log (
  id BIGSERIAL PRIMARY KEY,
  stock_movement_id BIGINT NOT NULL,
  event_type TEXT NOT NULL,
  old_values JSONB NULL,
  new_values JSONB NULL,
  user_id INTEGER NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by INTEGER NULL,
  updated_by INTEGER NULL
);

ALTER TABLE public.stock_movement_event_log
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE public.stock_movement_event_log
  ADD COLUMN IF NOT EXISTS created_by INTEGER NULL;
ALTER TABLE public.stock_movement_event_log
  ADD COLUMN IF NOT EXISTS updated_by INTEGER NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'stock_movement_event_log_movement_fkey'
  ) THEN
    ALTER TABLE public.stock_movement_event_log
      ADD CONSTRAINT stock_movement_event_log_movement_fkey
      FOREIGN KEY (stock_movement_id) REFERENCES public.stock_movements(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'stock_movement_event_log_user_fkey'
  ) THEN
    ALTER TABLE public.stock_movement_event_log
      ADD CONSTRAINT stock_movement_event_log_user_fkey
      FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'stock_movement_event_log_created_by_fkey'
  ) THEN
    ALTER TABLE public.stock_movement_event_log
      ADD CONSTRAINT stock_movement_event_log_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'stock_movement_event_log_updated_by_fkey'
  ) THEN
    ALTER TABLE public.stock_movement_event_log
      ADD CONSTRAINT stock_movement_event_log_updated_by_fkey
      FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS stock_movement_event_log_movement_idx ON public.stock_movement_event_log(stock_movement_id);
CREATE INDEX IF NOT EXISTS stock_movement_event_log_created_at_idx ON public.stock_movement_event_log(created_at);
CREATE INDEX IF NOT EXISTS stock_movement_event_log_event_type_idx ON public.stock_movement_event_log(event_type);


/* -------------------------------------------------------------------------- */
/* 5) updated_at triggers (only if shared function exists)                     */
/* -------------------------------------------------------------------------- */

DO $$
BEGIN
  IF to_regproc('public.tg_set_updated_at()') IS NULL THEN
    RAISE NOTICE 'tg_set_updated_at() not found; skipping updated_at triggers.';
    RETURN;
  END IF;

  EXECUTE 'DROP TRIGGER IF EXISTS articles_set_updated_at ON public.articles';
  EXECUTE 'CREATE TRIGGER articles_set_updated_at BEFORE UPDATE ON public.articles FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at()';

  EXECUTE 'DROP TRIGGER IF EXISTS magasins_set_updated_at ON public.magasins';
  EXECUTE 'CREATE TRIGGER magasins_set_updated_at BEFORE UPDATE ON public.magasins FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at()';

  EXECUTE 'DROP TRIGGER IF EXISTS emplacements_set_updated_at ON public.emplacements';
  EXECUTE 'CREATE TRIGGER emplacements_set_updated_at BEFORE UPDATE ON public.emplacements FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at()';

  EXECUTE 'DROP TRIGGER IF EXISTS lots_set_updated_at ON public.lots';
  EXECUTE 'CREATE TRIGGER lots_set_updated_at BEFORE UPDATE ON public.lots FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at()';

  EXECUTE 'DROP TRIGGER IF EXISTS stock_movements_set_updated_at ON public.stock_movements';
  EXECUTE 'CREATE TRIGGER stock_movements_set_updated_at BEFORE UPDATE ON public.stock_movements FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at()';

  EXECUTE 'DROP TRIGGER IF EXISTS stock_movement_lines_set_updated_at ON public.stock_movement_lines';
  EXECUTE 'CREATE TRIGGER stock_movement_lines_set_updated_at BEFORE UPDATE ON public.stock_movement_lines FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at()';

  EXECUTE 'DROP TRIGGER IF EXISTS stock_ledger_set_updated_at ON public.stock_ledger';
  EXECUTE 'CREATE TRIGGER stock_ledger_set_updated_at BEFORE UPDATE ON public.stock_ledger FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at()';

  EXECUTE 'DROP TRIGGER IF EXISTS stock_balances_set_updated_at ON public.stock_balances';
  EXECUTE 'CREATE TRIGGER stock_balances_set_updated_at BEFORE UPDATE ON public.stock_balances FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at()';
END $$;

COMMIT;
