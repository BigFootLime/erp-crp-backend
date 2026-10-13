\set ON_ERROR_STOP on
DO $$ BEGIN
  IF current_database()<>'material_bars_1246' THEN RAISE EXCEPTION 'Isolated fixture database required'; END IF;
END $$;
CREATE TABLE public.identification_labels(entity_type text NOT NULL,
  CONSTRAINT identification_labels_entity_type_ck CHECK(entity_type IN('STOCK_ARTICLE','STOCK_LOT','STOCK_LOCATION','WORK_ORDER','PURCHASE_ORDER','RECEPTION','QUALITY_CONTROL','TOOL','DELIVERY')));
CREATE TABLE public.identification_scan_events(entity_type text,expected_entity_types text[] NOT NULL,
  CONSTRAINT identification_scan_types_ck CHECK(cardinality(expected_entity_types)<=9));
