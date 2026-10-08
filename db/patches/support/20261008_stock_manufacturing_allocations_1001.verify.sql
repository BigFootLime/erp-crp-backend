DO $$ BEGIN
  IF to_regclass('public.stock_valuation_manufacturing_allocation_events') IS NULL
    OR to_regclass('public.stock_valuation_manufacturing_allocations') IS NULL THEN
    RAISE EXCEPTION 'Manufacturing allocation ledger or cursor missing';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='O'
    AND tgrelid IN('public.stock_valuation_manufacturing_allocation_events'::regclass,'public.stock_valuation_manufacturing_allocations'::regclass)
    AND tgname IN('stock_manufacturing_allocation_immutable','stock_manufacturing_allocation_truncate_guard',
      'stock_manufacturing_allocation_link_guard','stock_manufacturing_cursor_owner_guard','stock_manufacturing_cursor_truncate_guard'))<>5 THEN
    RAISE EXCEPTION 'Manufacturing immutable, link or cursor guards missing';
  END IF;
  IF EXISTS(SELECT 1 FROM public.stock_valuation_manufacturing_allocation_events
    WHERE source_sha256<>encode(digest(source_snapshot::text,'sha256'),'hex')) THEN
    RAISE EXCEPTION 'Manufacturing event proof invalid';
  END IF;
END $$;
