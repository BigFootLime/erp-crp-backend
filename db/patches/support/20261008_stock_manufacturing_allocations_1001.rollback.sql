-- Manual recovery only after stopping consumers and verifying backups.
BEGIN;
LOCK TABLE public.stock_valuation_manufacturing_allocation_events,public.stock_valuation_manufacturing_allocations IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM public.stock_valuation_manufacturing_allocation_events)
    OR EXISTS(SELECT 1 FROM public.stock_valuation_manufacturing_allocations) THEN
    RAISE EXCEPTION 'Manufacturing allocations exist; retain them and roll back application only';
  END IF;
END $$;
DROP TABLE public.stock_valuation_manufacturing_allocations;
DROP TABLE public.stock_valuation_manufacturing_allocation_events;
DROP FUNCTION public.fn_stock_manufacturing_cursor_guard_1001();
DROP FUNCTION public.fn_stock_manufacturing_allocation_link_guard_1001();
DROP FUNCTION public.fn_stock_manufacturing_inverse_bounds_1001(uuid);
DROP FUNCTION public.fn_stock_manufacturing_allocation_guard_1001();
COMMIT;
