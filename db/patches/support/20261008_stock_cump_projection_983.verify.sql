BEGIN READ ONLY;
DO $$ BEGIN
  IF (SELECT count(*) FROM public.stock_valuation_projector_control WHERE singleton)<>1
    OR (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='O'
      AND tgname IN('stock_valuation_entries_immutable','stock_valuation_entries_truncate_guard',
        'stock_valuation_balance_owner_guard','stock_valuation_balance_truncate_guard',
        'stock_valuation_projector_control_owner_guard','stock_valuation_projector_control_truncate_guard'))<>6 THEN
    RAISE EXCEPTION 'Stock CUMP projection structure invalid';
  END IF;
  IF EXISTS(SELECT 1 FROM public.stock_valuation_entries e
    LEFT JOIN public.stock_valuation_movement_journal j ON j.movement_id=e.movement_id
    WHERE e.source_sha256<>encode(digest(e.source_snapshot::text,'sha256'),'hex')
      OR(e.movement_id IS NOT NULL AND(j.movement_id IS NULL OR e.article_id<>j.article_id
        OR e.source_sequence<>j.sequence OR e.source_snapshot->>'stock_source_sha256' IS DISTINCT FROM j.source_sha256))) THEN
    RAISE EXCEPTION 'Stock CUMP entry proof integrity invalid';
  END IF;
  IF EXISTS(SELECT 1 FROM public.stock_valuation_balances b
    JOIN public.stock_valuation_entries e ON e.id=b.latest_entry_id
    WHERE (e.article_id,e.owner_key,e.stock_unit,e.currency) IS DISTINCT FROM (b.article_id,b.owner_key,b.stock_unit,b.currency)
      OR COALESCE(e.source_sequence,0)<>b.latest_sequence
      OR(e.source_snapshot->'after_state'->>'quantity')::numeric IS DISTINCT FROM b.quantity
      OR(e.source_snapshot->'after_state'->>'value')::numeric IS DISTINCT FROM b.value
      OR e.source_snapshot->'after_state'->>'reliability' IS DISTINCT FROM b.reliability
      OR e.source_snapshot->'after_state'->>'sourceRef' IS DISTINCT FROM b.source_ref) THEN
    RAISE EXCEPTION 'Stock CUMP balance chain invalid';
  END IF;
  IF EXISTS(SELECT 1 FROM public.stock_valuation_acquisition_allocations a
    WHERE a.basis_sha256<>encode(digest(a.basis_snapshot::text,'sha256'),'hex')) THEN
    RAISE EXCEPTION 'Stock CUMP fee cursor integrity invalid';
  END IF;
  IF EXISTS(SELECT 1 FROM public.stock_valuation_projector_control c WHERE c.mode='PREPARED'
    AND(c.initialized OR c.last_sequence<>0 OR EXISTS(SELECT 1 FROM public.stock_valuation_entries))) THEN
    RAISE EXCEPTION 'Prepared Stock CUMP projection unexpectedly contains valuation entries';
  END IF;
END $$;
SELECT mode,reporting_currency,formula_version,initialized,last_sequence,calculated_at FROM public.stock_valuation_projector_control;
SELECT count(*) AS entries,count(*) FILTER(WHERE kind='UNRESOLVED') AS unresolved FROM public.stock_valuation_entries;
ROLLBACK;
