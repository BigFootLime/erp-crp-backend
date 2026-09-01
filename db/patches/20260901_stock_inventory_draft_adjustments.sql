-- Materialise inventory discrepancies as auditable DRAFT stock movements as
-- soon as a count is saved. The movement is posted only when the approved
-- inventory closes, so saving or pausing never changes physical stock.
BEGIN;

ALTER TABLE public.stock_inventory_session_movements
  ADD COLUMN IF NOT EXISTS snapshot_line_id uuid NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'stock_inventory_session_movements_snapshot_line_fkey'
      AND conrelid = 'public.stock_inventory_session_movements'::regclass
  ) THEN
    ALTER TABLE public.stock_inventory_session_movements
      ADD CONSTRAINT stock_inventory_session_movements_snapshot_line_fkey
      FOREIGN KEY (snapshot_line_id)
      REFERENCES public.stock_inventory_snapshot_lines(id)
      ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS stock_inventory_session_movements_snapshot_idx
  ON public.stock_inventory_session_movements (session_id, snapshot_line_id, created_at DESC)
  WHERE snapshot_line_id IS NOT NULL;

COMMIT;
