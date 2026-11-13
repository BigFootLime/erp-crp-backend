BEGIN READ ONLY;
DO $$ BEGIN
  IF to_regprocedure('public.fn_stock_order_transport_basis_1016(uuid)') IS NULL
    OR to_regprocedure('public.fn_stock_acquisition_capture_980()') IS NULL
    OR (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='O'
      AND tgname='stock_acquisition_capture_980' AND tgrelid='public.stock_valuation_movement_journal'::regclass
      AND tgfoid='public.fn_stock_acquisition_capture_1016()'::regprocedure)<>1
    OR (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='O'
      AND tgname IN('stock_acquisition_sources_immutable','stock_acquisition_sources_truncate_guard'))<>2
    OR NOT EXISTS(SELECT 1 FROM public.stock_valuation_projector_control WHERE singleton AND mode='PREPARED') THEN
    RAISE EXCEPTION 'Transport capture guard/version invalid';
  END IF;
  IF EXISTS(SELECT 1 FROM public.stock_valuation_acquisition_sources a
    JOIN public.stock_valuation_movement_journal j ON j.movement_id=a.movement_id
    WHERE a.source_sha256<>encode(digest(a.source_snapshot::text,'sha256'),'hex')
      OR a.posting_transaction<>j.posting_transaction OR a.source_snapshot->>'stock_source_sha256' IS DISTINCT FROM j.source_sha256) THEN
    RAISE EXCEPTION 'Existing acquisition proof integrity invalid';
  END IF;
END $$;
SELECT mode,reporting_currency FROM public.stock_valuation_projector_control WHERE singleton;
ROLLBACK;
