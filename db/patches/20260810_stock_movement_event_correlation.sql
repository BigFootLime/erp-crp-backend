-- SOL-05 / stock movement audit correlation contract.
-- Additive only: apply after a table-level backup and the matching preflight.

BEGIN;

ALTER TABLE public.stock_movement_event_log
  ADD COLUMN IF NOT EXISTS correlation_id uuid NULL;

CREATE INDEX IF NOT EXISTS stock_movement_event_log_correlation_idx
  ON public.stock_movement_event_log (correlation_id)
  WHERE correlation_id IS NOT NULL;

COMMENT ON COLUMN public.stock_movement_event_log.correlation_id IS
  'Correlation identifier shared by the business action, stock movement and immutable audit events.';

COMMIT;
