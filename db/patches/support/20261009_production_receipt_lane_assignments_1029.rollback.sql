-- Roll the backend back to its previous release first. Used attribution evidence must be kept.
BEGIN;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM public.production_receipt_lane_intents)
    OR EXISTS(SELECT 1 FROM public.production_receipt_lane_assignments) THEN
    RAISE EXCEPTION 'Used production attribution evidence must be retained; restore the previous application only';
  END IF;
END $$;
DROP TABLE public.production_receipt_lane_assignments;
DROP TABLE public.production_receipt_lane_intents;
COMMIT;
