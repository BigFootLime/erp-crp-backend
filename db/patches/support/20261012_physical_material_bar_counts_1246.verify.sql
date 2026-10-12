\set ON_ERROR_STOP on
DO $$ BEGIN
  IF to_regclass('public.stock_inventory_material_bar_counts') IS NULL
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.stock_inventory_material_bar_counts'::regclass
      AND tgname='stock_material_bar_count_1246_immutable' AND tgenabled<>'D') THEN
    RAISE EXCEPTION 'Immutable physical count storage missing';
  END IF;
  IF EXISTS(SELECT 1 FROM public.stock_inventory_material_bar_counts c
    JOIN public.stock_inventory_count_events e ON e.id=c.count_event_id
    JOIN public.stock_inventory_snapshot_lines s ON s.id=e.snapshot_line_id
    WHERE c.stock_batch_id IS DISTINCT FROM s.stock_batch_id) THEN
    RAISE EXCEPTION 'A physical count does not match its inventory stock batch';
  END IF;
END $$;
