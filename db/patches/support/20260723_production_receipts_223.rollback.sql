\set ON_ERROR_STOP on

-- Guarded compensation for an empty #223 installation only.
-- Never run after business receipts have been recorded.
BEGIN;

DO $$
BEGIN
  IF current_database() <> 'cerp_test' THEN
    RAISE EXCEPTION '#223 rollback is restricted to cerp_test';
  END IF;
  IF to_regclass('public.of_receipts') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.of_receipts) THEN
    RAISE EXCEPTION '#223 rollback refused: immutable production receipts exist';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.stock_reservations
    WHERE lot_id IS NOT NULL OR stock_batch_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION '#223 rollback refused: lot-level reservations exist';
  END IF;
END $$;

DROP VIEW IF EXISTS public.v_stock_lot_availability;
DROP TABLE IF EXISTS public.of_receipts;
DROP FUNCTION IF EXISTS public.fn_protect_of_receipt();

DROP INDEX IF EXISTS public.stock_reservations_active_source_lot_uq;
DROP INDEX IF EXISTS public.stock_reservations_lot_idx;
DROP INDEX IF EXISTS public.stock_reservations_batch_idx;
ALTER TABLE public.stock_reservations
  DROP CONSTRAINT IF EXISTS stock_reservations_lot_id_fkey,
  DROP CONSTRAINT IF EXISTS stock_reservations_stock_batch_id_fkey,
  DROP COLUMN IF EXISTS lot_id,
  DROP COLUMN IF EXISTS stock_batch_id;

DROP INDEX IF EXISTS public.stock_batches_level_lot_uq;
DROP INDEX IF EXISTS public.stock_batches_lot_idx;
ALTER TABLE public.stock_batches
  DROP CONSTRAINT IF EXISTS stock_batches_lot_id_fkey,
  DROP COLUMN IF EXISTS lot_id;

COMMIT;
