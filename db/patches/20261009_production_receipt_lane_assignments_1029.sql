-- #1029: immutable attribution of new production receipts after real Quality release.
-- No historical receipt, stock balance or reservation is reclassified.
BEGIN;
DO $$ BEGIN
  IF to_regclass('public.stock_lane_locations') IS NULL
    OR to_regclass('public.delivery_promise_parts') IS NULL
    OR to_regclass('public.of_receipts') IS NULL THEN
    RAISE EXCEPTION '#1029 requires physical lane topology, production receipt evidence and AR promises';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.production_receipt_lane_intents (
  receipt_id uuid PRIMARY KEY REFERENCES public.of_receipts(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.production_receipt_lane_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id uuid NOT NULL REFERENCES public.production_receipt_lane_intents(receipt_id) ON DELETE RESTRICT,
  quantity numeric(18,3) NOT NULL CHECK(quantity>0),
  distribution jsonb NOT NULL CHECK(jsonb_typeof(distribution)='object'),
  quality_decision jsonb NOT NULL CHECK(jsonb_typeof(quality_decision)='object'),
  actor_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS production_receipt_lane_assignments_receipt_idx
  ON public.production_receipt_lane_assignments(receipt_id,created_at,id);
DROP TRIGGER IF EXISTS production_receipt_lane_intents_immutable ON public.production_receipt_lane_intents;
CREATE TRIGGER production_receipt_lane_intents_immutable BEFORE UPDATE OR DELETE
  ON public.production_receipt_lane_intents FOR EACH ROW EXECUTE FUNCTION public.fn_protect_stock_immutable_evidence();
DROP TRIGGER IF EXISTS production_receipt_lane_assignments_immutable ON public.production_receipt_lane_assignments;
CREATE TRIGGER production_receipt_lane_assignments_immutable BEFORE UPDATE OR DELETE
  ON public.production_receipt_lane_assignments FOR EACH ROW EXECUTE FUNCTION public.fn_protect_stock_immutable_evidence();
COMMENT ON TABLE public.production_receipt_lane_assignments IS
  'Released receipt attribution and exact reservation deltas. A lane denotes intended purpose; no physical transfer is implied.';
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='cerp_app') THEN
    GRANT SELECT,INSERT ON public.production_receipt_lane_intents,public.production_receipt_lane_assignments TO cerp_app;
  END IF;
END $$;
COMMIT;
