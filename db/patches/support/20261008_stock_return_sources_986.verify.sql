BEGIN READ ONLY;
DO $$ BEGIN
  IF (SELECT count(*) FROM public.stock_valuation_return_boundary WHERE singleton)<>1
    OR (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='O' AND tgname IN(
      'stock_return_boundary_immutable','stock_return_boundary_truncate_guard',
      'stock_return_sources_immutable','stock_return_sources_truncate_guard','stock_return_source_capture_986',
      'stock_return_allocation_immutable','stock_return_allocation_truncate_guard','stock_return_allocation_link_guard',
      'stock_return_cursor_owner_guard','stock_return_cursor_truncate_guard'))<>10 THEN
    RAISE EXCEPTION 'Stock return provenance structure invalid';
  END IF;
  IF EXISTS(SELECT 1 FROM public.stock_valuation_return_sources s
    JOIN public.stock_valuation_movement_journal j ON j.movement_id=s.movement_id
    WHERE s.source_sha256<>encode(digest(s.source_snapshot::text,'sha256'),'hex')
      OR s.posting_transaction<>j.posting_transaction
      OR s.source_snapshot->>'movement_id' IS DISTINCT FROM s.movement_id::text
      OR s.source_snapshot->>'stock_source_sha256' IS DISTINCT FROM j.source_sha256) THEN
    RAISE EXCEPTION 'Stock return source proof integrity invalid';
  END IF;
  IF EXISTS(SELECT 1 FROM public.stock_valuation_return_allocation_events e
    JOIN public.stock_valuation_entries applied ON applied.id=e.applied_entry_id
    JOIN public.stock_valuation_entries original ON original.id=e.original_entry_id
    WHERE e.source_sha256<>encode(digest(e.source_snapshot::text,'sha256'),'hex')
      OR applied.movement_id IS DISTINCT FROM e.applied_movement_id OR applied.kind NOT IN('RETURN','RECEIPT_REVERSAL')
      OR (applied.owner_key,applied.stock_unit,applied.currency) IS DISTINCT FROM (e.owner_key,e.stock_unit,e.currency)
      OR abs(applied.quantity_delta) IS DISTINCT FROM abs(e.quantity_delta)
      OR applied.movement_value IS DISTINCT FROM abs(e.value_delta)
      OR (original.movement_id,original.owner_key,original.stock_unit,original.currency)
        IS DISTINCT FROM (e.original_movement_id,e.owner_key,e.stock_unit,e.currency)
      OR original.article_id<>applied.article_id OR original.source_sequence>=applied.source_sequence) THEN
    RAISE EXCEPTION 'Stock return allocation entry proof invalid';
  END IF;
  IF EXISTS(SELECT 1 FROM public.stock_valuation_return_allocations c
    LEFT JOIN public.stock_valuation_return_allocation_events e ON e.id=c.latest_event_id
    WHERE e.id IS NULL OR (e.original_movement_id,e.original_entry_id,e.owner_key,e.stock_unit,e.currency)
      IS DISTINCT FROM (c.original_movement_id,c.original_entry_id,c.owner_key,c.stock_unit,c.currency)
      OR (e.source_snapshot->'after_cursor'->>'quantity')::numeric IS DISTINCT FROM c.quantity
      OR (e.source_snapshot->'after_cursor'->>'value')::numeric IS DISTINCT FROM c.value) THEN
    RAISE EXCEPTION 'Stock return net cursor proof invalid';
  END IF;
  IF EXISTS(SELECT 1 FROM (SELECT DISTINCT inverse_of_event_id
    FROM public.stock_valuation_return_allocation_events WHERE inverse_of_event_id IS NOT NULL) inverse
    WHERE NOT public.fn_stock_return_inverse_bounds_986(inverse.inverse_of_event_id)) THEN
    RAISE EXCEPTION 'Stock return event inverted beyond its original quantity or amount';
  END IF;
END $$;
SELECT started_at,schema_version FROM public.stock_valuation_return_boundary WHERE singleton;
SELECT mode,initialized,last_sequence FROM public.stock_valuation_projector_control WHERE singleton;
SELECT count(*) AS return_sources FROM public.stock_valuation_return_sources;
SELECT count(*) AS allocation_events FROM public.stock_valuation_return_allocation_events;
ROLLBACK;
