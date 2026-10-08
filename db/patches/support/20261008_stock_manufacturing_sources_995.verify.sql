BEGIN READ ONLY;
DO $$ BEGIN
  IF(SELECT count(*) FROM public.stock_valuation_manufacturing_boundary WHERE singleton)<>1
    OR(SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='O' AND tgname IN(
      'stock_manufacturing_boundary_immutable','stock_manufacturing_boundary_truncate_guard',
      'stock_manufacturing_sources_immutable','stock_manufacturing_sources_truncate_guard',
      'stock_manufacturing_source_capture_995'))<>5 THEN
    RAISE EXCEPTION 'Manufacturing source structure invalid';
  END IF;
  IF EXISTS(SELECT 1 FROM public.stock_valuation_manufacturing_sources s
    JOIN public.stock_valuation_movement_journal j ON j.movement_id=s.movement_id
    WHERE s.source_sha256<>encode(digest(s.source_snapshot::text,'sha256'),'hex')
      OR s.posting_transaction<>j.posting_transaction
      OR s.source_snapshot->>'movement_id' IS DISTINCT FROM s.movement_id::text
      OR s.source_snapshot->>'stock_source_sha256' IS DISTINCT FROM j.source_sha256) THEN
    RAISE EXCEPTION 'Manufacturing source proof invalid';
  END IF;
END $$;
SELECT started_at,schema_version FROM public.stock_valuation_manufacturing_boundary WHERE singleton;
SELECT mode,initialized,last_sequence FROM public.stock_valuation_projector_control WHERE singleton;
SELECT count(*) AS manufacturing_sources FROM public.stock_valuation_manufacturing_sources;
ROLLBACK;
