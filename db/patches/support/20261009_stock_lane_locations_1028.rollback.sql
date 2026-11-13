-- Guarded rollback is allowed only before any configuration/evidence was recorded.
BEGIN;
LOCK TABLE public.stock_lane_locations,public.stock_lane_configuration_events IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM public.stock_lane_locations)
    OR EXISTS(SELECT 1 FROM public.stock_lane_configuration_events) THEN
    RAISE EXCEPTION '#1028 configuration exists: preserve its audit, roll back the API release instead';
  END IF;
END $$;
DROP VIEW public.v_stock_lane_positions_1028;
DROP TABLE public.stock_lane_configuration_events;
DROP TABLE public.stock_lane_locations;
COMMIT;
