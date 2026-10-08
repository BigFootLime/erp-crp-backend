BEGIN READ ONLY;
DO $$ BEGIN
  IF (SELECT count(*) FROM public.stock_valuation_capture_boundary WHERE mode='CAPTURE_ONLY' AND schema_version=1)<>1
    OR (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal
      AND tgname IN('stock_valuation_journal_immutable','stock_valuation_boundary_immutable',
        'stock_valuation_posting_insert_977','stock_valuation_posting_update_977','stock_valuation_posted_line_mutation_977',
        'stock_valuation_opening_immutable','stock_valuation_journal_truncate_guard',
        'stock_valuation_boundary_truncate_guard','stock_valuation_opening_truncate_guard'))<>9
    OR (SELECT count(*) FROM pg_trigger WHERE tgdeferrable AND tginitdeferred
      AND tgname IN('stock_valuation_posting_insert_977','stock_valuation_posting_update_977'))<>2 THEN
    RAISE EXCEPTION 'Stock valuation capture structure invalid';
  END IF;
  IF EXISTS(SELECT 1 FROM public.stock_valuation_movement_journal j
    JOIN public.stock_movements m ON m.id=j.movement_id
    WHERE j.article_id<>m.article_id OR j.posted_at IS DISTINCT FROM m.posted_at
      OR j.source_sha256<>encode(digest(j.source_snapshot::text,'sha256'),'hex')) THEN
    RAISE EXCEPTION 'Stock valuation source journal integrity invalid';
  END IF;
  IF EXISTS(SELECT 1 FROM public.stock_valuation_opening_quantities o
    WHERE o.source_sha256<>encode(digest(o.source_snapshot::text,'sha256'),'hex')) THEN
    RAISE EXCEPTION 'Stock valuation opening source integrity invalid';
  END IF;
END $$;
SELECT mode,started_at,schema_version FROM public.stock_valuation_capture_boundary;
SELECT capture_status,count(*) FROM public.stock_valuation_movement_journal GROUP BY capture_status;
ROLLBACK;
