\set ON_ERROR_STOP on
DO $$ BEGIN
  IF current_database()<>'material_bars_1246' THEN RAISE EXCEPTION 'Isolated fixture database required'; END IF;
END $$;
-- Minimal posting fixture only: canonical stock counters are updated explicitly
-- by the test. This does not replace full ERP reception/quality acceptance.
ALTER TABLE public.stock_movements ADD COLUMN article_id uuid REFERENCES public.articles(id);
ALTER TABLE public.stock_movements ADD COLUMN movement_type text;
ALTER TABLE public.stock_movements ADD COLUMN qty numeric;
INSERT INTO public.users VALUES(1246) ON CONFLICT DO NOTHING;
