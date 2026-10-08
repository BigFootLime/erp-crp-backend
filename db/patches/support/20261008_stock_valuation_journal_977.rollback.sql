-- Empty test/dev capture only. Once real postings have been captured, preserve
-- the journal and use the approved recovery backup instead of erasing proofs.
BEGIN;
SET LOCAL lock_timeout='10s';
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM public.stock_valuation_movement_journal) THEN
    RAISE EXCEPTION 'Stock valuation journal contains proofs; restore the pre-release backup instead';
  END IF;
END $$;
DROP TRIGGER stock_valuation_posted_line_mutation_977 ON public.stock_movement_lines;
DROP TRIGGER stock_valuation_posting_insert_977 ON public.stock_movements;
DROP TRIGGER stock_valuation_posting_update_977 ON public.stock_movements;
DROP TABLE public.stock_valuation_movement_journal;
DROP TABLE public.stock_valuation_capture_boundary;
DROP TABLE public.stock_valuation_opening_quantities;
DROP FUNCTION public.fn_stock_valuation_posted_line_guard_977();
DROP FUNCTION public.fn_stock_valuation_posting_capture_977();
DROP FUNCTION public.fn_stock_valuation_journal_guard_977();
DROP FUNCTION public.fn_stock_valuation_boundary_guard_977();
COMMIT;
