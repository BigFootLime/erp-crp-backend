\set ON_ERROR_STOP on
DO $$ BEGIN
  IF current_database()<>'material_bars_1246' THEN RAISE EXCEPTION 'Isolated fixture database required'; END IF;
END $$;
-- Add to the receipt fixture; the tests apply canonical quantities explicitly.
ALTER TABLE public.stock_movements ADD COLUMN doc_type text;
ALTER TABLE public.stock_movements ADD COLUMN doc_id uuid;
