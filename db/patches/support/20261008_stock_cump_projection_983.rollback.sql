-- Empty Test/dev only. After activation preserve immutable financial proofs.
BEGIN;
SET LOCAL lock_timeout='10s';
LOCK TABLE public.stock_valuation_projector_control IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM public.stock_valuation_entries)
    OR EXISTS(SELECT 1 FROM public.stock_valuation_balances)
    OR EXISTS(SELECT 1 FROM public.stock_valuation_acquisition_allocations)
    OR EXISTS(SELECT 1 FROM public.stock_valuation_return_allocations)
    OR EXISTS(SELECT 1 FROM public.stock_valuation_projector_control WHERE mode<>'PREPARED' OR initialized OR last_sequence<>0) THEN
    RAISE EXCEPTION 'Stock CUMP projection has financial evidence; retain compatible tables or use the pre-release backup';
  END IF;
END $$;
DROP TABLE public.stock_valuation_return_allocations;
DROP TABLE public.stock_valuation_acquisition_allocations;
DROP TABLE public.stock_valuation_balances;
DROP TABLE public.stock_valuation_entries;
DROP TABLE public.stock_valuation_projector_control;
DROP INDEX public.stock_acquisition_order_source_983_idx;
DROP FUNCTION public.fn_stock_valuation_balance_guard_983();
DROP FUNCTION public.fn_stock_valuation_entry_guard_983();
DROP FUNCTION public.fn_stock_valuation_projector_control_guard_983();
COMMIT;
