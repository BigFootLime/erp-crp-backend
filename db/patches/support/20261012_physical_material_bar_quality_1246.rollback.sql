BEGIN;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM public.stock_material_bars WHERE depreciated_length_mm<>0)
    OR EXISTS(SELECT 1 FROM public.stock_material_bar_events WHERE action='DEPRECIATE' OR after_state ? 'depreciatedMm' OR before_state ? 'depreciatedMm') THEN
    RAISE EXCEPTION 'Physical quality evidence exists: retain schema and roll application forward';
  END IF;
  IF to_regclass('public.stock_inventory_material_bar_counts') IS NOT NULL THEN
    IF EXISTS(SELECT 1 FROM public.stock_inventory_material_bar_counts c,
      LATERAL jsonb_array_elements(c.measurement->'bars') bar WHERE bar ? 'depreciatedMm') THEN
      RAISE EXCEPTION 'Physical quality evidence exists in counts: retain schema and roll application forward';
    END IF;
  END IF;
END $$;
DROP TRIGGER IF EXISTS stock_material_quality_1246 ON public.stock_material_bars;
DROP TRIGGER IF EXISTS stock_material_inventory_quality_1246 ON public.stock_material_bar_inventories;
DROP TRIGGER IF EXISTS stock_material_batch_quality_1246 ON public.stock_batches;
DROP TRIGGER IF EXISTS stock_material_hold_quality_1246 ON public.stock_material_bar_reservations;
DROP FUNCTION IF EXISTS public.check_material_bar_quality_1246();
ALTER TABLE public.stock_material_bar_events DROP CONSTRAINT IF EXISTS stock_material_bar_quality_movement_1246;
ALTER TABLE public.stock_material_bar_events DROP CONSTRAINT IF EXISTS stock_material_bar_events_action_check;
ALTER TABLE public.stock_material_bar_events ADD CONSTRAINT stock_material_bar_events_action_check
  CHECK (action IN ('INITIALIZE','RECONCILE','RESERVE','RELEASE','CUT','COMPENSATE','MOVE','TRANSFER','RESTORE'));
ALTER TABLE public.stock_material_bars DROP COLUMN IF EXISTS depreciated_length_mm;
COMMIT;
