DO $$ BEGIN
  IF to_regclass('public.stock_valuation_manufacturing_bases') IS NULL
    OR to_regclass('public.stock_valuation_manufacturing_sources') IS NULL
    OR to_regclass('public.stock_valuation_return_allocation_events') IS NULL THEN
    RAISE EXCEPTION 'Manufacturing base, receipt and return ledger prerequisites missing';
  END IF;
  IF to_regclass('public.stock_valuation_manufacturing_allocation_events') IS NOT NULL
    OR to_regclass('public.stock_valuation_manufacturing_allocations') IS NOT NULL THEN
    RAISE EXCEPTION 'Manufacturing ledger already exists; use migration status and verification';
  END IF;
END $$;
