BEGIN READ ONLY;
DO $$ BEGIN
  IF (SELECT count(*) FROM public.stock_valuation_acquisition_boundary WHERE singleton AND schema_version=1)<>1
    OR (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='O'
      AND tgname IN('stock_acquisition_boundary_immutable','stock_acquisition_boundary_truncate_guard',
        'stock_acquisition_sources_immutable','stock_acquisition_sources_truncate_guard','stock_acquisition_capture_980'))<>5 THEN
    RAISE EXCEPTION 'Stock acquisition capture structure invalid';
  END IF;
  IF EXISTS(SELECT 1 FROM public.stock_valuation_acquisition_sources s
    JOIN public.stock_valuation_movement_journal j ON j.movement_id=s.movement_id
    WHERE s.source_sha256<>encode(digest(s.source_snapshot::text,'sha256'),'hex')
      OR s.posting_transaction<>j.posting_transaction
      OR s.source_snapshot->>'stock_source_sha256' IS DISTINCT FROM j.source_sha256
      OR s.source_snapshot->>'article_id' IS DISTINCT FROM j.article_id::text
      OR j.source_snapshot->>'movement_type'<>'IN') THEN
    RAISE EXCEPTION 'Stock acquisition proof integrity invalid';
  END IF;
END $$;
SELECT started_at,schema_version FROM public.stock_valuation_acquisition_boundary;
SELECT count(*) AS captured_receipts,count(*) FILTER(WHERE jsonb_array_length(source_issues)>0) AS incomplete_sources
  FROM public.stock_valuation_acquisition_sources;
ROLLBACK;
