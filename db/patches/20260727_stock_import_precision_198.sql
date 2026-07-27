-- Issue #198 — preserve the canonical six-decimal stock quantity precision.
-- cerp_test only. The repair is restricted to one-line CLIPPER opening
-- movements whose line differs from the posted header by less than 0.0005,
-- which is the maximum loss introduced by NUMERIC(18,3).

BEGIN;

DO $$
DECLARE
  current_scale integer;
BEGIN
  IF current_database() <> 'cerp_test' THEN
    RAISE EXCEPTION 'Patch #198 refused outside cerp_test (current database: %)', current_database();
  END IF;

  SELECT numeric_scale
    INTO current_scale
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'stock_movement_lines'
    AND column_name = 'qty';

  IF current_scale IS NULL THEN
    RAISE EXCEPTION 'Patch #198 refused: public.stock_movement_lines.qty is missing';
  END IF;
  IF current_scale NOT IN (3, 6) THEN
    RAISE EXCEPTION 'Patch #198 refused: unexpected stock_movement_lines.qty scale %', current_scale;
  END IF;
END
$$;

ALTER TABLE public.stock_movement_lines
  ALTER COLUMN qty TYPE numeric(18,6)
  USING qty::numeric(18,6);

-- The normal immutability trigger is retained for application traffic. It is
-- disabled only inside this transaction for the bounded, audited repair below.
ALTER TABLE public.stock_movement_lines
  DISABLE TRIGGER trg_protect_posted_stock_movement_line;

WITH opening_lines AS (
  SELECT
    l.id AS line_id,
    l.movement_id,
    l.qty AS old_line_qty,
    m.qty AS posted_qty,
    COALESCE(m.posted_by, m.updated_by, m.created_by, m.user_id) AS actor_user_id,
    COUNT(*) OVER (PARTITION BY l.movement_id) AS lines_count
  FROM public.stock_movement_lines l
  JOIN public.stock_movements m ON m.id = l.movement_id
  WHERE m.status = 'POSTED'
    AND m.source_document_type = 'CLIPPER_STOCK_OPENING'
),
repaired AS (
  UPDATE public.stock_movement_lines l
  SET
    qty = opening_lines.posted_qty,
    updated_at = now(),
    updated_by = opening_lines.actor_user_id
  FROM opening_lines
  WHERE l.id = opening_lines.line_id
    AND opening_lines.lines_count = 1
    AND opening_lines.old_line_qty IS DISTINCT FROM opening_lines.posted_qty
    AND abs(opening_lines.old_line_qty - opening_lines.posted_qty) < 0.0005
  RETURNING
    opening_lines.movement_id,
    opening_lines.old_line_qty,
    opening_lines.posted_qty,
    opening_lines.actor_user_id
)
INSERT INTO public.stock_movement_event_log (
  id,
  stock_movement_id,
  event_type,
  old_values,
  new_values,
  user_id,
  created_by,
  updated_by
)
SELECT
  gen_random_uuid(),
  movement_id,
  'PRECISION_RECONCILED_198',
  jsonb_build_object('line_qty', old_line_qty),
  jsonb_build_object(
    'line_qty', posted_qty,
    'reason', 'Widen stock_movement_lines.qty from NUMERIC(18,3) to NUMERIC(18,6)'
  ),
  actor_user_id,
  actor_user_id,
  actor_user_id
FROM repaired;

ALTER TABLE public.stock_movement_lines
  ENABLE TRIGGER trg_protect_posted_stock_movement_line;

COMMIT;
