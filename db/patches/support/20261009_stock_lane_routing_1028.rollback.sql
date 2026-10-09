BEGIN;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM public.stock_lane_destinations) OR EXISTS(SELECT 1 FROM public.production_receipt_lane_routes) THEN
    RAISE EXCEPTION 'Used routing topology and immutable physical evidence must be retained; roll back the application instead';
  END IF;
END $$;
DROP TABLE public.production_receipt_lane_routes;
DROP TABLE public.stock_lane_destinations;
COMMIT;
