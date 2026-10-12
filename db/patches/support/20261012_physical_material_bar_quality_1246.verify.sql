DO $$ BEGIN
  IF to_regprocedure('public.check_material_bar_quality_1246()') IS NULL
    OR 4 <> (SELECT count(*) FROM pg_trigger WHERE tgname IN ('stock_material_quality_1246','stock_material_inventory_quality_1246','stock_material_batch_quality_1246','stock_material_hold_quality_1246') AND tgenabled <> 'D') THEN
    RAISE EXCEPTION 'Physical bar quality guards are incomplete';
  END IF;
END $$;
-- Historical aggregate depreciation cannot identify a bar. Surface it for
-- explicit reconciliation; do not invent geometry or alter canonical balances.
SELECT b.id AS batch_to_reconcile FROM public.stock_batches b JOIN public.stock_material_bar_inventories i ON i.stock_batch_id=b.id
WHERE b.qty_depreciated IS DISTINCT FROM (SELECT COALESCE(sum(depreciated_length_mm),0) FROM public.stock_material_bars bar WHERE bar.stock_batch_id=b.id AND bar.retired_at IS NULL);
