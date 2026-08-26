-- Explicit, idempotent opening imports for the historical (OLD) stock base.
-- The physical location remains an operator-owned BASE-OLD emplacement; this
-- patch never invents a warehouse/location or changes existing balances.
-- Apply after 20260826_z_lots_scope_canonicalization.sql. The zz filename is
-- deliberately ordered after that canonical OLD/NEW migration by db-patches.

BEGIN;

CREATE TABLE IF NOT EXISTS public.historical_stock_import_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  request_payload JSONB NOT NULL,
  article_id UUID NULL REFERENCES public.articles(id) ON DELETE RESTRICT,
  lot_id UUID NULL REFERENCES public.lots(id) ON DELETE RESTRICT,
  movement_id UUID NULL REFERENCES public.stock_movements(id) ON DELETE RESTRICT,
  result_payload JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT historical_stock_import_receipts_key_len_chk CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  CONSTRAINT historical_stock_import_receipts_hash_chk CHECK (request_hash ~ '^[A-Fa-f0-9]{64}$'),
  CONSTRAINT historical_stock_import_receipts_actor_key_uniq UNIQUE (actor_user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS historical_stock_import_receipts_created_idx
  ON public.historical_stock_import_receipts (created_at DESC);

COMMIT;
