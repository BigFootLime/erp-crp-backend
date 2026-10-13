-- #1248. Barcode payloads keep the existing opaque CERP identification format.
BEGIN;
ALTER TABLE public.stock_material_bars
  ADD COLUMN IF NOT EXISTS public_number bigint GENERATED ALWAYS AS IDENTITY;
CREATE UNIQUE INDEX IF NOT EXISTS stock_material_bars_public_number_1248_uq
  ON public.stock_material_bars(public_number);

ALTER TABLE public.identification_labels DROP CONSTRAINT IF EXISTS identification_labels_entity_type_ck;
ALTER TABLE public.identification_labels ADD CONSTRAINT identification_labels_entity_type_ck CHECK (entity_type IN (
  'STOCK_ARTICLE','STOCK_LOT','STOCK_MATERIAL_BAR','STOCK_LOCATION','WORK_ORDER','PURCHASE_ORDER',
  'RECEPTION','QUALITY_CONTROL','TOOL','DELIVERY'
));
ALTER TABLE public.identification_scan_events DROP CONSTRAINT IF EXISTS identification_scan_types_ck;
ALTER TABLE public.identification_scan_events ADD CONSTRAINT identification_scan_types_ck
  CHECK (cardinality(expected_entity_types) <= 10);

CREATE OR REPLACE FUNCTION public.protect_material_bar_identity_1246() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='stock_material_bars' THEN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.stock_batch_id IS DISTINCT FROM OLD.stock_batch_id
      OR NEW.initial_length_mm IS DISTINCT FROM OLD.initial_length_mm
      OR NEW.public_number IS DISTINCT FROM OLD.public_number THEN
      RAISE EXCEPTION 'Physical bar identity is immutable; record a reconciliation or movement' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.bar_id IS DISTINCT FROM OLD.bar_id OR NEW.reservation_id IS DISTINCT FROM OLD.reservation_id THEN
    RAISE EXCEPTION 'Physical bar hold identity is immutable; release and allocate explicitly' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DO $$ DECLARE sequence_name text; BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cerp_app') THEN
    sequence_name := pg_get_serial_sequence('public.stock_material_bars','public_number');
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %s TO cerp_app',sequence_name);
  END IF;
END $$;
COMMIT;
