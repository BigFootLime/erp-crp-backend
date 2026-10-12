\set ON_ERROR_STOP on
DO $$ BEGIN
  IF current_database()<>'material_bars_1246' THEN RAISE EXCEPTION 'Isolated fixture database required'; END IF;
END $$;
-- Add to the receipt fixture; the tests apply canonical quantities explicitly.
ALTER TABLE public.stock_movements ADD COLUMN doc_type text;
ALTER TABLE public.stock_movements ADD COLUMN doc_id uuid;
ALTER TABLE public.stock_movements ADD COLUMN reversal_of_id uuid REFERENCES public.stock_movements(id);
CREATE TABLE public.articles_matiere(article_id uuid PRIMARY KEY REFERENCES public.articles(id),barre_a_decouper boolean);
GRANT SELECT,INSERT,UPDATE,DELETE ON public.articles_matiere TO cerp_app;
