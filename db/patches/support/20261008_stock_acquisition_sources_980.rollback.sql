-- Empty Test/dev only. Captured prices are historical proofs, never disposable.
BEGIN;
SET LOCAL lock_timeout='10s';
LOCK TABLE public.stock_movements IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM public.stock_valuation_acquisition_sources) THEN
    RAISE EXCEPTION 'Stock acquisition sources contain proofs; preserve the compatible tables or use the pre-release backup';
  END IF;
END $$;
DROP TRIGGER stock_acquisition_capture_980 ON public.stock_valuation_movement_journal;
DROP TABLE public.stock_valuation_acquisition_sources;
DROP TABLE public.stock_valuation_acquisition_boundary;
DROP FUNCTION public.fn_stock_acquisition_capture_980();
DROP FUNCTION public.fn_stock_acquisition_guard_980();
COMMIT;
