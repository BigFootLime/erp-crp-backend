\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
  current_scale integer;
BEGIN
  IF current_database() <> 'cerp_test' THEN
    RAISE EXCEPTION 'Rollback #198 refused outside cerp_test (current database: %)', current_database();
  END IF;

  SELECT numeric_scale
    INTO current_scale
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'stock_movement_lines'
    AND column_name = 'qty';

  IF current_scale <> 6 THEN
    RAISE EXCEPTION 'Rollback #198 refused: expected scale 6, found %', current_scale;
  END IF;
END
$$;

ALTER TABLE public.stock_movement_lines
  DISABLE TRIGGER trg_protect_posted_stock_movement_line;

WITH latest_repair AS (
  SELECT DISTINCT ON (stock_movement_id)
    stock_movement_id,
    (old_values ->> 'line_qty')::numeric(18,6) AS old_line_qty,
    user_id
  FROM public.stock_movement_event_log
  WHERE event_type = 'PRECISION_RECONCILED_198'
  ORDER BY stock_movement_id, created_at DESC, id DESC
),
restored AS (
  UPDATE public.stock_movement_lines l
  SET
    qty = latest_repair.old_line_qty,
    updated_at = now(),
    updated_by = latest_repair.user_id
  FROM latest_repair
  WHERE l.movement_id = latest_repair.stock_movement_id
  RETURNING l.movement_id, latest_repair.user_id
)
INSERT INTO public.stock_movement_event_log (
  id,
  stock_movement_id,
  event_type,
  new_values,
  user_id,
  created_by,
  updated_by
)
SELECT
  gen_random_uuid(),
  movement_id,
  'PRECISION_ROLLBACK_198',
  jsonb_build_object('reason', 'Rollback issue #198'),
  user_id,
  user_id,
  user_id
FROM restored;

ALTER TABLE public.stock_movement_lines
  ENABLE TRIGGER trg_protect_posted_stock_movement_line;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.stock_movement_lines
    WHERE qty <> round(qty, 3)
  ) THEN
    RAISE EXCEPTION 'Rollback #198 refused: six-decimal quantities exist outside the audited repair set';
  END IF;
END
$$;

ALTER TABLE public.stock_movement_lines
  ALTER COLUMN qty TYPE numeric(18,3)
  USING qty::numeric(18,3);

COMMIT;
