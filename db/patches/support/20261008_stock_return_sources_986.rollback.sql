-- Empty Test/dev only. Preserve any captured proof; use a compatible release
-- or the verified pre-deployment backup once capture has begun.
BEGIN;
SET LOCAL lock_timeout='10s';
LOCK TABLE public.stock_movements IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.stock_valuation_projector_control IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM public.stock_valuation_return_sources)
    OR EXISTS(SELECT 1 FROM public.stock_valuation_return_allocation_events)
    OR EXISTS(SELECT 1 FROM public.stock_valuation_return_allocations)
    OR EXISTS(SELECT 1 FROM public.stock_valuation_entries)
    OR EXISTS(SELECT 1 FROM public.stock_valuation_projector_control WHERE mode<>'PREPARED' OR initialized OR last_sequence<>0) THEN
    RAISE EXCEPTION 'Stock return evidence exists; retain compatible tables or use the pre-release backup';
  END IF;
END $$;
DROP TRIGGER stock_return_source_capture_986 ON public.stock_valuation_movement_journal;
DROP TRIGGER stock_return_cursor_owner_guard ON public.stock_valuation_return_allocations;
DROP TRIGGER stock_return_cursor_truncate_guard ON public.stock_valuation_return_allocations;
ALTER TABLE public.stock_valuation_return_allocations DROP COLUMN latest_event_id;
DROP TABLE public.stock_valuation_return_allocation_events;
DROP TABLE public.stock_valuation_return_sources;
DROP TABLE public.stock_valuation_return_boundary;
DROP FUNCTION public.fn_stock_return_cursor_guard_986();
DROP FUNCTION public.fn_stock_return_allocation_link_guard_986();
DROP FUNCTION public.fn_stock_return_allocation_guard_986();
DROP FUNCTION public.fn_stock_return_inverse_bounds_986(uuid);
DROP FUNCTION public.fn_stock_return_source_capture_986();
DROP FUNCTION public.fn_stock_return_source_guard_986();
COMMIT;
