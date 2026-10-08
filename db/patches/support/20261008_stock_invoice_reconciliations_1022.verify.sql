DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['fn_stock_invoice_physical_1022(uuid,text)','fn_stock_invoice_candidate_1022(uuid,text)',
 'fn_supplier_invoice_sources_1022(uuid)','fn_stock_invoice_math_1022(jsonb,jsonb,jsonb)',
 'fn_stock_invoice_parent_guard_1022()','fn_stock_invoice_child_guard_1022()',
 'fn_stock_invoice_entry_guard_1022()','fn_stock_invoice_commit_guard_1022()'] LOOP
 IF to_regprocedure('public.'||name) IS NULL THEN RAISE EXCEPTION 'Invoice function missing: %',name; END IF; END LOOP;
 IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='O' AND tgname IN(
 'stock_invoice_parent_immutable','stock_invoice_parent_truncate','stock_invoice_scope_immutable','stock_invoice_scope_truncate',
 'stock_invoice_consumption_immutable','stock_invoice_consumption_truncate','stock_invoice_entry_guard','stock_invoice_commit_guard'))<>8
 OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='stock_invoice_commit_guard' AND tgdeferrable AND tginitdeferred)
 OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.stock_valuation_entries'::regclass AND conname='stock_invoice_posting_unique_1022')
 OR to_regprocedure('public.fn_stock_value_adjustment_guard_1007()') IS NULL
 OR to_regprocedure('public.fn_stock_valuation_entry_guard_983()') IS NULL THEN RAISE EXCEPTION 'Invoice guards or preserved guards missing'; END IF;
END $$;
SELECT mode,initialized,reporting_currency,last_sequence FROM public.stock_valuation_projector_control WHERE singleton;
