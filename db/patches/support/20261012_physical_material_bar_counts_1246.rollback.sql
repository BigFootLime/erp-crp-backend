-- Only an unused installation can be removed. Keep recorded count evidence.
BEGIN;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM public.stock_inventory_material_bar_counts) THEN
    RAISE EXCEPTION 'Physical count evidence exists: retain schema and roll application forward';
  END IF;
END $$;
DROP TABLE IF EXISTS public.stock_inventory_material_bar_counts;
DROP FUNCTION IF EXISTS public.protect_material_bar_count_1246();
COMMIT;
