-- #1246. Preserve the scanned identity of a whole, unreserved bar when moving
-- it to another location. No data rewrite and no inferred stock geometry.
BEGIN;
CREATE OR REPLACE FUNCTION public.protect_material_bar_identity_1246() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE proof record; moved_length numeric;
BEGIN
  IF TG_TABLE_NAME='stock_material_bars' THEN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.initial_length_mm IS DISTINCT FROM OLD.initial_length_mm THEN
      RAISE EXCEPTION 'Physical bar identity and initial length are immutable' USING ERRCODE='23514';
    END IF;
    IF NEW.stock_batch_id IS DISTINCT FROM OLD.stock_batch_id THEN
      IF NEW.remaining_length_mm IS DISTINCT FROM OLD.remaining_length_mm OR OLD.remaining_length_mm<=0
        OR NEW.row_version<>OLD.row_version+1 OR OLD.retired_at IS NOT NULL OR NEW.retired_at IS NOT NULL
        OR EXISTS(SELECT 1 FROM public.stock_material_bar_reservations h WHERE h.bar_id=OLD.id AND h.remaining_length_mm>0) THEN
        RAISE EXCEPTION 'Only an entire unreserved bar can change location' USING ERRCODE='23514';
      END IF;
      SELECT e.stock_movement_id,m.qty INTO proof
      FROM public.stock_material_bar_events e
      JOIN public.stock_movements m ON m.id=e.stock_movement_id
      JOIN public.stock_batches src ON src.id=OLD.stock_batch_id
      JOIN public.stock_batches dst ON dst.id=NEW.stock_batch_id AND dst.lot_id=src.lot_id
      JOIN public.stock_levels sl ON sl.id=src.stock_level_id AND sl.article_id=m.article_id
      JOIN public.stock_levels dl ON dl.id=dst.stock_level_id AND dl.article_id=m.article_id
      WHERE e.bar_id=OLD.id AND e.action='MOVE' AND e.command_key=m.id
        AND m.status='POSTED' AND m.movement_type::text='TRANSFER' AND m.qty>0 AND m.stock_batch_id=src.id
        AND e.before_state->>'batchId'=src.id::text AND e.after_state->>'batchId'=dst.id::text
        AND e.before_state->>'id'=OLD.id::text AND e.after_state->>'id'=NEW.id::text
        AND (e.before_state->>'version')::integer=OLD.row_version AND (e.after_state->>'version')::integer=NEW.row_version
        AND (e.before_state->>'lengthMm')::numeric=OLD.remaining_length_mm AND (e.after_state->>'lengthMm')::numeric=NEW.remaining_length_mm
        AND 2=(SELECT count(*) FROM public.stock_movements leg WHERE leg.doc_type='STOCK_TRANSFER_INTERNAL' AND leg.doc_id=m.id)
        AND EXISTS(SELECT 1 FROM public.stock_movements leg WHERE leg.doc_type='STOCK_TRANSFER_INTERNAL' AND leg.doc_id=m.id
          AND leg.status='POSTED' AND leg.movement_type::text='OUT' AND leg.article_id=m.article_id AND leg.stock_batch_id=src.id AND leg.qty=m.qty)
        AND EXISTS(SELECT 1 FROM public.stock_movements leg WHERE leg.doc_type='STOCK_TRANSFER_INTERNAL' AND leg.doc_id=m.id
          AND leg.status='POSTED' AND leg.movement_type::text='IN' AND leg.article_id=m.article_id AND leg.stock_batch_id=dst.id AND leg.qty=m.qty);
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Moving a bar requires immutable proof and both posted transfer legs' USING ERRCODE='23514';
      END IF;
      SELECT sum((after_state->>'lengthMm')::numeric) INTO moved_length
        FROM public.stock_material_bar_events WHERE action='MOVE' AND stock_movement_id=proof.stock_movement_id;
      IF moved_length IS DISTINCT FROM proof.qty THEN
        RAISE EXCEPTION 'Transferred bar lengths must equal the canonical transfer quantity' USING ERRCODE='23514';
      END IF;
    END IF;
  ELSIF NEW.bar_id IS DISTINCT FROM OLD.bar_id OR NEW.reservation_id IS DISTINCT FROM OLD.reservation_id THEN
    RAISE EXCEPTION 'Physical bar hold identity is immutable; release and allocate explicitly' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION public.protect_material_bar_identity_1246() OWNER TO cerp_app;

-- A managed receipt/debit/correction may finish geometry after posting its
-- canonical movement. It must do so BEFORE COMMIT. Legacy command paths get
-- the same invariant; they cannot silently leave a confirmed inventory stale.
CREATE OR REPLACE FUNCTION public.check_material_bar_stock_1246() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE affected uuid[]; batch uuid; canonical numeric; physical numeric; watermark bigint; posted bigint;
BEGIN
  IF TG_TABLE_NAME='stock_batches' THEN
    IF TG_OP='DELETE' THEN affected:=ARRAY[OLD.id]; ELSE affected:=ARRAY[NEW.id]; END IF;
  ELSE
    IF TG_OP='INSERT' THEN affected:=ARRAY[NEW.stock_batch_id];
    ELSIF TG_OP='DELETE' THEN affected:=ARRAY[OLD.stock_batch_id];
    ELSE affected:=ARRAY[OLD.stock_batch_id,NEW.stock_batch_id]; END IF;
  END IF;
  FOR batch IN SELECT DISTINCT id FROM unnest(affected) AS id WHERE id IS NOT NULL ORDER BY id LOOP
    SELECT b.qty_total,i.movement_count INTO canonical,watermark FROM public.stock_batches b
      JOIN public.stock_material_bar_inventories i ON i.stock_batch_id=b.id WHERE b.id=batch FOR UPDATE OF b,i;
    IF NOT FOUND THEN CONTINUE; END IF;
    SELECT COALESCE(sum(remaining_length_mm),0) INTO physical FROM public.stock_material_bars
      WHERE stock_batch_id=batch AND retired_at IS NULL;
    SELECT count(*) INTO posted FROM public.stock_movements WHERE stock_batch_id=batch AND status='POSTED';
    IF physical IS DISTINCT FROM canonical OR watermark IS DISTINCT FROM posted THEN
      RAISE EXCEPTION 'Physical bars and canonical stock must reconcile before commit'
        USING ERRCODE='23514',CONSTRAINT='stock_material_geometry_complete_1246';
    END IF;
  END LOOP;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS stock_material_bar_stock_1246 ON public.stock_material_bars;
CREATE CONSTRAINT TRIGGER stock_material_bar_stock_1246 AFTER INSERT OR UPDATE OR DELETE ON public.stock_material_bars
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_material_bar_stock_1246();
DROP TRIGGER IF EXISTS stock_material_inventory_stock_1246 ON public.stock_material_bar_inventories;
CREATE CONSTRAINT TRIGGER stock_material_inventory_stock_1246 AFTER INSERT OR UPDATE OR DELETE ON public.stock_material_bar_inventories
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_material_bar_stock_1246();
DROP TRIGGER IF EXISTS stock_material_movement_stock_1246 ON public.stock_movements;
CREATE CONSTRAINT TRIGGER stock_material_movement_stock_1246 AFTER INSERT OR UPDATE OR DELETE ON public.stock_movements
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_material_bar_stock_1246();
DROP TRIGGER IF EXISTS stock_material_batch_stock_1246 ON public.stock_batches;
CREATE CONSTRAINT TRIGGER stock_material_batch_stock_1246 AFTER UPDATE ON public.stock_batches
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_material_bar_stock_1246();
ALTER FUNCTION public.check_material_bar_stock_1246() OWNER TO cerp_app;
COMMIT;
