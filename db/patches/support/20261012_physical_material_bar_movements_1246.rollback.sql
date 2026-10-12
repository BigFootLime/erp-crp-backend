-- Restore the former strict guard. Historical moves and bar locations remain
-- intact; a rollback never reverses physical stock or erases its audit trail.
BEGIN;
CREATE OR REPLACE FUNCTION public.protect_material_bar_identity_1246() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='stock_material_bars' THEN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.stock_batch_id IS DISTINCT FROM OLD.stock_batch_id
      OR NEW.initial_length_mm IS DISTINCT FROM OLD.initial_length_mm THEN
      RAISE EXCEPTION 'Physical bar identity is immutable; record a reconciliation or movement' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.bar_id IS DISTINCT FROM OLD.bar_id OR NEW.reservation_id IS DISTINCT FROM OLD.reservation_id THEN
    RAISE EXCEPTION 'Physical bar hold identity is immutable; release and allocate explicitly' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION public.protect_material_bar_identity_1246() OWNER TO cerp_app;
COMMIT;
