-- Additive topology defaults and immutable routing evidence; no historical stock is moved.
BEGIN;
CREATE TABLE IF NOT EXISTS public.stock_lane_destinations (
  lane text PRIMARY KEY CHECK (lane IN ('FREE','DELIVERY','ASSEMBLY')),
  location_id uuid NOT NULL UNIQUE REFERENCES public.locations(id) ON DELETE RESTRICT,
  updated_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.production_receipt_lane_routes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id uuid NOT NULL REFERENCES public.of_receipts(id) ON DELETE RESTRICT,
  quantity numeric(18,3) NOT NULL CHECK (quantity>0),
  destinations jsonb NOT NULL CHECK (jsonb_typeof(destinations)='array'),
  actor_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS production_receipt_lane_routes_receipt_idx ON public.production_receipt_lane_routes(receipt_id);
DROP TRIGGER IF EXISTS production_receipt_lane_routes_immutable ON public.production_receipt_lane_routes;
CREATE TRIGGER production_receipt_lane_routes_immutable BEFORE UPDATE OR DELETE ON public.production_receipt_lane_routes
  FOR EACH ROW EXECUTE FUNCTION public.fn_protect_stock_immutable_evidence();
GRANT SELECT,INSERT,UPDATE,DELETE ON public.stock_lane_destinations TO cerp_app;
GRANT SELECT,INSERT ON public.production_receipt_lane_routes TO cerp_app;
COMMIT;
