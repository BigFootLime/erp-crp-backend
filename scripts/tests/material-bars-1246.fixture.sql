\set ON_ERROR_STOP on
DO $$ BEGIN
  IF current_database()<>'material_bars_1246' THEN RAISE EXCEPTION 'Isolated fixture database required'; END IF;
END $$;
CREATE TABLE public.users(id integer PRIMARY KEY);
CREATE TABLE public.stock_batches(id uuid PRIMARY KEY,lot_id uuid,stock_level_id uuid,qty_total numeric NOT NULL,qty_reserved numeric NOT NULL);
CREATE TABLE public.stock_reservations(id uuid PRIMARY KEY,stock_batch_id uuid REFERENCES public.stock_batches(id),qty_reserved numeric NOT NULL,qty_consumed numeric NOT NULL,status text NOT NULL,expires_at timestamptz);
CREATE TABLE public.stock_movements(id uuid PRIMARY KEY,stock_batch_id uuid REFERENCES public.stock_batches(id),status text NOT NULL);
GRANT SELECT,INSERT,UPDATE,DELETE ON public.users,public.stock_batches,public.stock_reservations,public.stock_movements TO cerp_app;
CREATE FUNCTION public.fixture_id_1246(text) RETURNS uuid LANGUAGE sql IMMUTABLE AS 'SELECT md5($1)::uuid';
GRANT EXECUTE ON FUNCTION public.fixture_id_1246(text) TO cerp_app;
