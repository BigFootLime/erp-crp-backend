-- Manual recovery only, after services stop and backups are verified. Never
-- discard an approved cost basis; nonempty tables require application rollback.
BEGIN;
LOCK TABLE public.stock_valuation_manufacturing_bases IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM public.stock_valuation_manufacturing_bases) THEN
    RAISE EXCEPTION 'Manufacturing bases exist; preserve them and roll back application only';
  END IF;
END $$;
DROP TABLE public.stock_valuation_manufacturing_bases;
DROP FUNCTION public.fn_stock_manufacturing_basis_guard_998();
COMMIT;
