BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.stock_material_bars) OR EXISTS (SELECT 1 FROM public.identification_labels WHERE entity_type='STOCK_MATERIAL_BAR')
    OR EXISTS (SELECT 1 FROM public.identification_scan_events WHERE entity_type='STOCK_MATERIAL_BAR' OR 'STOCK_MATERIAL_BAR'=ANY(expected_entity_types)) THEN
    RAISE EXCEPTION 'Rollback refused: physical bar identity or scan evidence exists. Roll back application code and retain this additive schema.';
  END IF;
END $$;
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
ALTER TABLE public.stock_material_bars DROP COLUMN IF EXISTS public_number;
ALTER TABLE public.identification_labels DROP CONSTRAINT identification_labels_entity_type_ck;
ALTER TABLE public.identification_labels ADD CONSTRAINT identification_labels_entity_type_ck CHECK (entity_type IN (
  'STOCK_ARTICLE','STOCK_LOT','STOCK_LOCATION','WORK_ORDER','PURCHASE_ORDER','RECEPTION','QUALITY_CONTROL','TOOL','DELIVERY'
));
ALTER TABLE public.identification_scan_events DROP CONSTRAINT identification_scan_types_ck;
ALTER TABLE public.identification_scan_events ADD CONSTRAINT identification_scan_types_ck CHECK (cardinality(expected_entity_types)<=9);
COMMIT;
