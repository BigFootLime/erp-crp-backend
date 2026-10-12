-- Depreciated material remains physically present. No inferred bar allocation:
-- historical discrepancies are explicitly reconciled before stock is used.
BEGIN;
ALTER TABLE public.stock_material_bars ADD COLUMN IF NOT EXISTS depreciated_length_mm numeric(14,3) NOT NULL DEFAULT 0;
ALTER TABLE public.stock_material_bars DROP CONSTRAINT IF EXISTS stock_material_bar_quality_length_1246;
ALTER TABLE public.stock_material_bars ADD CONSTRAINT stock_material_bar_quality_length_1246
  CHECK (depreciated_length_mm >= 0 AND depreciated_length_mm <= remaining_length_mm);
ALTER TABLE public.stock_material_bar_events DROP CONSTRAINT IF EXISTS stock_material_bar_events_action_check;
ALTER TABLE public.stock_material_bar_events ADD CONSTRAINT stock_material_bar_events_action_check
  CHECK (action IN ('INITIALIZE','RECONCILE','RESERVE','RELEASE','CUT','COMPENSATE','MOVE','TRANSFER','RESTORE','DEPRECIATE'));
ALTER TABLE public.stock_material_bar_events DROP CONSTRAINT IF EXISTS stock_material_bar_quality_movement_1246;
ALTER TABLE public.stock_material_bar_events ADD CONSTRAINT stock_material_bar_quality_movement_1246
  CHECK (action <> 'DEPRECIATE' OR stock_movement_id IS NOT NULL);

CREATE OR REPLACE FUNCTION public.check_material_bar_quality_1246() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE affected uuid[]; batch uuid; canonical numeric; assigned numeric;
BEGIN
  IF TG_TABLE_NAME='stock_batches' THEN
    IF TG_OP='DELETE' THEN affected:=ARRAY[OLD.id]; ELSE affected:=ARRAY[NEW.id]; END IF;
  ELSIF TG_TABLE_NAME='stock_material_bar_reservations' THEN
    IF TG_OP='DELETE' THEN SELECT ARRAY[stock_batch_id] INTO affected FROM public.stock_material_bars WHERE id=OLD.bar_id;
    ELSE SELECT ARRAY[stock_batch_id] INTO affected FROM public.stock_material_bars WHERE id=NEW.bar_id; END IF;
  ELSE
    IF TG_OP='INSERT' THEN affected:=ARRAY[NEW.stock_batch_id];
    ELSIF TG_OP='DELETE' THEN affected:=ARRAY[OLD.stock_batch_id];
    ELSE affected:=ARRAY[OLD.stock_batch_id,NEW.stock_batch_id]; END IF;
  END IF;
  FOR batch IN SELECT DISTINCT id FROM unnest(affected) AS id WHERE id IS NOT NULL ORDER BY id LOOP
    SELECT b.qty_depreciated INTO canonical FROM public.stock_batches b
      JOIN public.stock_material_bar_inventories i ON i.stock_batch_id=b.id WHERE b.id=batch FOR UPDATE OF b,i;
    IF NOT FOUND THEN CONTINUE; END IF;
    SELECT COALESCE(sum(depreciated_length_mm),0) INTO assigned FROM public.stock_material_bars WHERE stock_batch_id=batch AND retired_at IS NULL;
    IF assigned IS DISTINCT FROM canonical OR EXISTS (
      SELECT 1 FROM public.stock_material_bars b WHERE b.stock_batch_id=batch AND b.retired_at IS NULL
      AND b.depreciated_length_mm + COALESCE((SELECT sum(h.remaining_length_mm) FROM public.stock_material_bar_reservations h WHERE h.bar_id=b.id),0) > b.remaining_length_mm
    ) THEN
      RAISE EXCEPTION 'Depreciated material must match its physical bars without overlapping reservations'
        USING ERRCODE='23514',CONSTRAINT='stock_material_quality_complete_1246';
    END IF;
  END LOOP;
  RETURN NULL;
END $$;
ALTER FUNCTION public.check_material_bar_quality_1246() OWNER TO cerp_app;
DROP TRIGGER IF EXISTS stock_material_quality_1246 ON public.stock_material_bars;
CREATE CONSTRAINT TRIGGER stock_material_quality_1246 AFTER INSERT OR UPDATE OR DELETE ON public.stock_material_bars
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_material_bar_quality_1246();
DROP TRIGGER IF EXISTS stock_material_inventory_quality_1246 ON public.stock_material_bar_inventories;
CREATE CONSTRAINT TRIGGER stock_material_inventory_quality_1246 AFTER INSERT OR UPDATE OR DELETE ON public.stock_material_bar_inventories
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_material_bar_quality_1246();
DROP TRIGGER IF EXISTS stock_material_batch_quality_1246 ON public.stock_batches;
CREATE CONSTRAINT TRIGGER stock_material_batch_quality_1246 AFTER UPDATE ON public.stock_batches
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_material_bar_quality_1246();
DROP TRIGGER IF EXISTS stock_material_hold_quality_1246 ON public.stock_material_bar_reservations;
CREATE CONSTRAINT TRIGGER stock_material_hold_quality_1246 AFTER INSERT OR UPDATE OR DELETE ON public.stock_material_bar_reservations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_material_bar_quality_1246();
COMMIT;
