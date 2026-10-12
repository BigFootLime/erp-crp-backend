-- Rollback is allowed only before any geometry has been recorded.
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.stock_material_bar_inventories)
    OR EXISTS (SELECT 1 FROM public.stock_material_bar_events) THEN
    RAISE EXCEPTION 'Physical bar history exists; use a forward repair, never discard it';
  END IF;
END $$;
DROP TABLE public.stock_material_bar_events;
DROP TABLE public.stock_material_bar_reservations;
DROP TABLE public.stock_material_bars;
DROP TABLE public.stock_material_bar_inventories;
DROP TRIGGER stock_material_bar_reservation_total_1246 ON public.stock_reservations;
DROP FUNCTION public.check_material_bar_hold_1246();
DROP FUNCTION public.check_material_bar_reservation_1246();
DROP FUNCTION public.protect_material_bar_event_1246();
DROP FUNCTION public.protect_material_bar_identity_1246();
COMMIT;
