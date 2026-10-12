DO $$ BEGIN IF current_database()<>'material_bars_1246' THEN RAISE EXCEPTION 'Isolated fixture database required'; END IF; END $$;
ALTER TABLE public.stock_batches ADD COLUMN IF NOT EXISTS qty_depreciated numeric NOT NULL DEFAULT 0;
