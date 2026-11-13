DO $$ BEGIN
 IF to_regprocedure('public.fn_stock_value_candidate_1007(uuid,text)') IS NULL
 OR to_regprocedure('public.fn_stock_opening_scope_1004(text)') IS NULL
 OR to_regclass('public.supplier_invoices') IS NULL OR to_regclass('public.stock_valuation_acquisition_sources') IS NULL
 OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.stock_valuation_entries'::regclass AND conname='stock_value_posting_unique_1007') THEN
 RAISE EXCEPTION 'Invoice variance prerequisites missing'; END IF;
 IF to_regclass('public.stock_valuation_invoice_reconciliations') IS NOT NULL THEN RAISE EXCEPTION 'Invoice migration already present'; END IF;
END $$;
