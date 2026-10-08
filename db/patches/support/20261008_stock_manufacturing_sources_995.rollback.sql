-- Operator rollback only after backup. Never discard captured provenance.
BEGIN;
LOCK TABLE public.stock_movements IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.stock_valuation_projector_control IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM public.stock_valuation_manufacturing_sources)
    OR EXISTS(SELECT 1 FROM public.stock_valuation_entries)
    OR NOT EXISTS(SELECT 1 FROM public.stock_valuation_projector_control
      WHERE singleton AND mode='PREPARED' AND NOT initialized AND last_sequence=0) THEN
    RAISE EXCEPTION 'Manufacturing source rollback requires empty inactive structures';
  END IF;
END $$;
DROP TRIGGER stock_manufacturing_source_capture_995 ON public.stock_valuation_movement_journal;
DROP TABLE public.stock_valuation_manufacturing_sources;
DROP FUNCTION public.fn_stock_manufacturing_source_capture_995();
DROP FUNCTION public.fn_stock_manufacturing_source_guard_995();
DROP TABLE public.stock_valuation_manufacturing_boundary;
COMMIT;
