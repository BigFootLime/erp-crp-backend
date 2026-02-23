-- Stock trigger model alignment:
-- - Apply stock movements ONLY when status becomes POSTED.
-- - Fix UNRESERVE semantics (decrease qty_reserved instead of increasing qty_total).
-- - Handle ADJUSTMENT and SCRAP enum values.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_apply_stock_movement()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  -- Apply only when the movement is posted.
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'POSTED' THEN
      RETURN NEW;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    -- Apply once, on transition to POSTED.
    IF NEW.status IS DISTINCT FROM 'POSTED' OR OLD.status = 'POSTED' THEN
      RETURN NEW;
    END IF;
  END IF;

  IF NEW.movement_type = 'IN' THEN
    UPDATE stock_levels SET qty_total = qty_total + NEW.qty, updated_at = now()
    WHERE id = NEW.stock_level_id;
    IF NEW.stock_batch_id IS NOT NULL THEN
      UPDATE stock_batches SET qty_total = qty_total + NEW.qty WHERE id = NEW.stock_batch_id;
    END IF;

  ELSIF NEW.movement_type = 'OUT' THEN
    UPDATE stock_levels SET qty_total = qty_total - NEW.qty, updated_at = now()
    WHERE id = NEW.stock_level_id;
    IF NEW.stock_batch_id IS NOT NULL THEN
      UPDATE stock_batches SET qty_total = qty_total - NEW.qty WHERE id = NEW.stock_batch_id;
    END IF;

  ELSIF NEW.movement_type = 'RESERVE' THEN
    UPDATE stock_levels SET qty_reserved = qty_reserved + NEW.qty, updated_at = now()
    WHERE id = NEW.stock_level_id;
    IF NEW.stock_batch_id IS NOT NULL THEN
      UPDATE stock_batches SET qty_reserved = qty_reserved + NEW.qty WHERE id = NEW.stock_batch_id;
    END IF;

  ELSIF NEW.movement_type = 'UNRESERVE' THEN
    UPDATE stock_levels SET qty_reserved = qty_reserved - NEW.qty, updated_at = now()
    WHERE id = NEW.stock_level_id;
    IF NEW.stock_batch_id IS NOT NULL THEN
      UPDATE stock_batches SET qty_reserved = qty_reserved - NEW.qty WHERE id = NEW.stock_batch_id;
    END IF;

  ELSIF NEW.movement_type = 'DEPRECIATE' THEN
    UPDATE stock_levels SET qty_depreciated = qty_depreciated + NEW.qty, updated_at = now()
    WHERE id = NEW.stock_level_id;
    IF NEW.stock_batch_id IS NOT NULL THEN
      UPDATE stock_batches SET qty_depreciated = qty_depreciated + NEW.qty WHERE id = NEW.stock_batch_id;
    END IF;

  ELSIF NEW.movement_type = 'SCRAP' THEN
    -- Treat SCRAP as depreciation (keeps qty_total, removes from available).
    UPDATE stock_levels SET qty_depreciated = qty_depreciated + NEW.qty, updated_at = now()
    WHERE id = NEW.stock_level_id;
    IF NEW.stock_batch_id IS NOT NULL THEN
      UPDATE stock_batches SET qty_depreciated = qty_depreciated + NEW.qty WHERE id = NEW.stock_batch_id;
    END IF;

  ELSIF NEW.movement_type = 'ADJUST' OR NEW.movement_type = 'ADJUSTMENT' THEN
    -- Signed qty (positive = IN, negative = OUT).
    UPDATE stock_levels SET qty_total = qty_total + NEW.qty, updated_at = now()
    WHERE id = NEW.stock_level_id;
    IF NEW.stock_batch_id IS NOT NULL THEN
      UPDATE stock_batches SET qty_total = qty_total + NEW.qty WHERE id = NEW.stock_batch_id;
    END IF;

  ELSIF NEW.movement_type = 'TRANSFER' THEN
    NULL; -- handled applicatively by 2 movements (OUT + IN)
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_apply_stock_movement ON public.stock_movements;
CREATE TRIGGER trg_apply_stock_movement
AFTER INSERT OR UPDATE OF status ON public.stock_movements
FOR EACH ROW
EXECUTE FUNCTION public.fn_apply_stock_movement();

COMMIT;
