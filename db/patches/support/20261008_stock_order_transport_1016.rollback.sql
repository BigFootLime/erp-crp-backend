-- Restore future capture only. Preserve compatible tables, receipts and all immutable proofs.
BEGIN;
SET LOCAL lock_timeout='10s';
LOCK TABLE public.stock_movements IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.stock_valuation_projector_control WHERE singleton AND mode='PREPARED') THEN
    RAISE EXCEPTION 'Disable valuation via its controlled procedure before capture rollback';
  END IF;
END $$;
DROP TRIGGER stock_acquisition_capture_980 ON public.stock_valuation_movement_journal;
CREATE TRIGGER stock_acquisition_capture_980 AFTER INSERT ON public.stock_valuation_movement_journal
  FOR EACH ROW EXECUTE FUNCTION public.fn_stock_acquisition_capture_980();
DROP FUNCTION public.fn_stock_acquisition_capture_1016();
DROP FUNCTION public.fn_stock_order_transport_basis_1016(uuid);
COMMIT;
