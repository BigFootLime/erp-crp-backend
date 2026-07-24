-- Issue #223 - Fin d'OF, reception de production et mise en stock.
-- Additive/idempotent patch. Validate on cerp_test before any production proposal.
-- This patch does not delete or rewrite historical production/stock rows.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.ordres_fabrication') IS NULL
     OR to_regclass('public.of_output_lots') IS NULL
     OR to_regclass('public.lots') IS NULL
     OR to_regclass('public.stock_levels') IS NULL
     OR to_regclass('public.stock_batches') IS NULL
     OR to_regclass('public.stock_movements') IS NULL
     OR to_regclass('public.stock_reservations') IS NULL
     OR to_regclass('public.non_conformity') IS NULL THEN
    RAISE EXCEPTION '#223 prerequisites missing: OF, lot, stock, reservation and quality tables are required';
  END IF;
END $$;

-- A batch is the physical stock representation of one internal lot at one
-- stock level. Existing rows are linked only when article + batch code identify
-- exactly the canonical lot; no guessed link is introduced.
ALTER TABLE public.stock_batches
  ADD COLUMN IF NOT EXISTS lot_id uuid NULL;

UPDATE public.stock_batches sb
SET lot_id = l.id
FROM public.stock_levels sl
JOIN public.lots l ON l.article_id = sl.article_id
WHERE sl.id = sb.stock_level_id
  AND sb.lot_id IS NULL
  AND l.lot_code::text = sb.batch_code::text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_batches_lot_id_fkey'
      AND conrelid = 'public.stock_batches'::regclass
  ) THEN
    ALTER TABLE public.stock_batches
      ADD CONSTRAINT stock_batches_lot_id_fkey
      FOREIGN KEY (lot_id) REFERENCES public.lots(id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS stock_batches_lot_idx
  ON public.stock_batches(lot_id)
  WHERE lot_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS stock_batches_level_lot_uq
  ON public.stock_batches(stock_level_id, lot_id)
  WHERE lot_id IS NOT NULL;

-- Reservations created from production receipts keep their exact lot/batch
-- allocation. Historical reservations remain valid with nullable links.
ALTER TABLE public.stock_reservations
  ADD COLUMN IF NOT EXISTS lot_id uuid NULL,
  ADD COLUMN IF NOT EXISTS stock_batch_id uuid NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_reservations_lot_id_fkey'
      AND conrelid = 'public.stock_reservations'::regclass
  ) THEN
    ALTER TABLE public.stock_reservations
      ADD CONSTRAINT stock_reservations_lot_id_fkey
      FOREIGN KEY (lot_id) REFERENCES public.lots(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_reservations_stock_batch_id_fkey'
      AND conrelid = 'public.stock_reservations'::regclass
  ) THEN
    ALTER TABLE public.stock_reservations
      ADD CONSTRAINT stock_reservations_stock_batch_id_fkey
      FOREIGN KEY (stock_batch_id) REFERENCES public.stock_batches(id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS stock_reservations_lot_idx
  ON public.stock_reservations(lot_id)
  WHERE lot_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS stock_reservations_batch_idx
  ON public.stock_reservations(stock_batch_id)
  WHERE stock_batch_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS stock_reservations_active_source_lot_uq
  ON public.stock_reservations(source_type, source_id, article_id, location_id, lot_id)
  WHERE status = 'ACTIVE' AND lot_id IS NOT NULL;

-- Immutable command ledger: one actor/key identifies one semantic request and
-- stores the committed result for safe HTTP retries.
CREATE TABLE IF NOT EXISTS public.of_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  of_id bigint NOT NULL REFERENCES public.ordres_fabrication(id) ON DELETE RESTRICT,
  actor_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  request_payload jsonb NOT NULL,
  result_payload jsonb NOT NULL,
  expected_of_updated_at timestamptz NOT NULL,
  qty_ok numeric(12,3) NOT NULL,
  qty_scrap numeric(12,3) NOT NULL DEFAULT 0,
  qty_rework numeric(12,3) NOT NULL DEFAULT 0,
  quality_status text NOT NULL,
  quality_reason text NULL,
  location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE RESTRICT,
  lot_id uuid NOT NULL REFERENCES public.lots(id) ON DELETE RESTRICT,
  stock_level_id uuid NOT NULL REFERENCES public.stock_levels(id) ON DELETE RESTRICT,
  stock_batch_id uuid NOT NULL REFERENCES public.stock_batches(id) ON DELETE RESTRICT,
  stock_movement_id uuid NOT NULL REFERENCES public.stock_movements(id) ON DELETE RESTRICT,
  reservation_id uuid NULL REFERENCES public.stock_reservations(id) ON DELETE SET NULL,
  non_conformity_id uuid NULL REFERENCES public.non_conformity(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT of_receipts_actor_key_uq UNIQUE (actor_user_id, idempotency_key),
  CONSTRAINT of_receipts_movement_uq UNIQUE (stock_movement_id),
  CONSTRAINT of_receipts_key_len_ck CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  CONSTRAINT of_receipts_request_hash_ck CHECK (request_hash ~ '^[A-Fa-f0-9]{64}$'),
  CONSTRAINT of_receipts_qty_ck CHECK (qty_ok > 0 AND qty_scrap >= 0 AND qty_rework >= 0),
  CONSTRAINT of_receipts_quality_status_ck CHECK (quality_status IN ('LIBERE', 'QUARANTAINE', 'BLOQUE')),
  CONSTRAINT of_receipts_quality_reason_ck CHECK (
    quality_status = 'LIBERE' OR NULLIF(btrim(quality_reason), '') IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS of_receipts_of_created_idx
  ON public.of_receipts(of_id, created_at DESC);
CREATE INDEX IF NOT EXISTS of_receipts_lot_idx
  ON public.of_receipts(lot_id, created_at DESC);
CREATE INDEX IF NOT EXISTS of_receipts_nc_idx
  ON public.of_receipts(non_conformity_id)
  WHERE non_conformity_id IS NOT NULL;

COMMENT ON TABLE public.of_receipts IS
  'Immutable, idempotent production-receipt command ledger for issue #223.';
COMMENT ON COLUMN public.of_receipts.request_hash IS
  'SHA-256 of the canonical OF id + validated request body. A reused key with another hash is rejected.';

CREATE OR REPLACE FUNCTION public.fn_protect_of_receipt()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'OF receipts are immutable audit evidence'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_of_receipt ON public.of_receipts;
CREATE TRIGGER trg_protect_of_receipt
BEFORE UPDATE OR DELETE ON public.of_receipts
FOR EACH ROW EXECUTE FUNCTION public.fn_protect_of_receipt();

-- Reader-facing availability: on-hand is physical stock, while usable stock is
-- released stock net of reservation/depreciation. Quarantine and blocked stock
-- remain visible but can never be promised as available.
CREATE OR REPLACE VIEW public.v_stock_lot_availability AS
SELECT
  sb.id AS stock_batch_id,
  sb.stock_level_id,
  sl.article_id,
  sl.location_id,
  sb.lot_id,
  l.lot_code,
  l.lot_status,
  sb.qty_total AS qty_on_hand,
  sb.qty_reserved,
  sb.qty_depreciated,
  CASE
    WHEN l.lot_status IN ('QUARANTAINE', 'EN_ATTENTE') THEN GREATEST(sb.qty_total - sb.qty_depreciated, 0)
    ELSE 0
  END AS qty_quarantine,
  CASE
    WHEN l.lot_status = 'BLOQUE' THEN GREATEST(sb.qty_total - sb.qty_depreciated, 0)
    ELSE 0
  END AS qty_blocked,
  CASE
    WHEN l.lot_status = 'LIBERE' THEN GREATEST(sb.qty_total - sb.qty_reserved - sb.qty_depreciated, 0)
    ELSE 0
  END AS qty_available
FROM public.stock_batches sb
JOIN public.stock_levels sl ON sl.id = sb.stock_level_id
LEFT JOIN public.lots l ON l.id = sb.lot_id;

COMMENT ON VIEW public.v_stock_lot_availability IS
  'Explicit on-hand/quarantine/blocked/reserved/available quantities by stock batch and internal lot.';

-- Runtime least privilege. The migration remains portable when the deployment
-- role has another name; grants are applied only when cerp_app exists.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    GRANT SELECT, INSERT ON public.of_receipts TO cerp_app;
    GRANT SELECT ON public.v_stock_lot_availability TO cerp_app;
  END IF;
END $$;

COMMIT;
