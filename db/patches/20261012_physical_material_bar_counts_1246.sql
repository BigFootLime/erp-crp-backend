-- Physical measurements belong to immutable count events, not mutable totals.
BEGIN;
CREATE TABLE IF NOT EXISTS public.stock_inventory_material_bar_counts (
  count_event_id uuid PRIMARY KEY REFERENCES public.stock_inventory_count_events(id) ON DELETE RESTRICT,
  stock_batch_id uuid NOT NULL REFERENCES public.stock_batches(id) ON DELETE RESTRICT,
  geometry_changed boolean NOT NULL,
  measurement jsonb NOT NULL CHECK (jsonb_typeof(measurement)='object'
    AND measurement ? 'expectedVersion' AND measurement ? 'bars'
    AND jsonb_typeof(measurement->'bars')='array'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stock_inventory_material_bar_counts_batch_1246_idx
  ON public.stock_inventory_material_bar_counts(stock_batch_id,count_event_id);
CREATE OR REPLACE FUNCTION public.protect_material_bar_count_1246() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE context record; measured numeric;
BEGIN
  IF TG_OP='INSERT' THEN
    SELECT e.counted_qty,s.stock_batch_id,session.status INTO context FROM public.stock_inventory_count_events e
      JOIN public.stock_inventory_snapshot_lines s ON s.id=e.snapshot_line_id AND s.session_id=e.session_id
      JOIN public.stock_inventory_sessions session ON session.id=e.session_id WHERE e.id=NEW.count_event_id;
    SELECT COALESCE(sum((value->>'lengthMm')::numeric),0) INTO measured FROM jsonb_array_elements(NEW.measurement->'bars');
    IF context.stock_batch_id IS NULL OR context.stock_batch_id IS DISTINCT FROM NEW.stock_batch_id OR context.status<>'OPEN'
      OR measured IS DISTINCT FROM context.counted_qty THEN
      RAISE EXCEPTION 'Physical measurement does not match its open inventory count' USING ERRCODE='23514',CONSTRAINT='stock_material_count_context_1246';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Physical inventory counts are immutable; append a new count' USING ERRCODE='23514';
END $$;
DROP TRIGGER IF EXISTS stock_material_bar_count_1246_immutable ON public.stock_inventory_material_bar_counts;
CREATE TRIGGER stock_material_bar_count_1246_immutable BEFORE INSERT OR UPDATE OR DELETE ON public.stock_inventory_material_bar_counts
  FOR EACH ROW EXECUTE FUNCTION public.protect_material_bar_count_1246();
ALTER TABLE public.stock_inventory_material_bar_counts OWNER TO cerp_app;
ALTER FUNCTION public.protect_material_bar_count_1246() OWNER TO cerp_app;
GRANT SELECT,INSERT ON public.stock_inventory_material_bar_counts TO cerp_app;
COMMIT;
