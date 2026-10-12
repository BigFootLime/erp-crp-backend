\set ON_ERROR_STOP on
DO $$ BEGIN IF current_database()<>'material_bars_1246' THEN RAISE EXCEPTION 'Isolated fixture database required'; END IF; END $$;
CREATE TABLE public.stock_inventory_sessions(id uuid PRIMARY KEY,status text NOT NULL,requires_second_count boolean DEFAULT false);
CREATE TABLE public.stock_inventory_snapshot_lines(id uuid PRIMARY KEY,session_id uuid REFERENCES public.stock_inventory_sessions(id),
  stock_batch_id uuid REFERENCES public.stock_batches(id),article_id uuid REFERENCES public.articles(id),lot_id uuid REFERENCES public.lots(id),theoretical_qty numeric);
CREATE TABLE public.stock_inventory_count_events(id uuid PRIMARY KEY,session_id uuid REFERENCES public.stock_inventory_sessions(id),
  snapshot_line_id uuid REFERENCES public.stock_inventory_snapshot_lines(id),counted_qty numeric,count_round integer,created_at timestamptz DEFAULT now());
CREATE TABLE public.stock_inventory_session_movements(session_id uuid REFERENCES public.stock_inventory_sessions(id),
  snapshot_line_id uuid REFERENCES public.stock_inventory_snapshot_lines(id),stock_movement_id uuid REFERENCES public.stock_movements(id),PRIMARY KEY(session_id,stock_movement_id));
GRANT SELECT,INSERT,UPDATE,DELETE ON public.stock_inventory_sessions,public.stock_inventory_snapshot_lines,
  public.stock_inventory_count_events,public.stock_inventory_session_movements TO cerp_app;
