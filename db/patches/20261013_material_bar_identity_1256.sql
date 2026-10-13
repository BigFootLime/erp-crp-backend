-- #1256. Preserve immutable barcode numbers together with proven physical transfers.
BEGIN;
SET LOCAL lock_timeout='5s';
CREATE OR REPLACE FUNCTION public.protect_material_bar_identity_1246() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE proof record; moved_length numeric;
BEGIN
  IF TG_TABLE_NAME='stock_material_bars' THEN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.initial_length_mm IS DISTINCT FROM OLD.initial_length_mm
      OR NEW.public_number IS DISTINCT FROM OLD.public_number THEN
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
COMMIT;
