DO $$ BEGIN
  IF to_regclass('public.stock_valuation_value_adjustments') IS NULL
    OR to_regprocedure('public.fn_stock_value_candidate_1007(uuid,text)') IS NULL
    OR to_regprocedure('public.fn_stock_value_physical_1007(uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'Documented current-value structures are missing';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.stock_valuation_value_adjustments'::regclass
      AND NOT tgisinternal AND tgenabled='O')<>3
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.stock_valuation_value_adjustments'::regclass
      AND tgname='stock_value_adjustment_commit_guard' AND tgdeferrable AND tginitdeferred AND tgenabled='O')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.stock_valuation_entries'::regclass
      AND tgname='stock_value_adjustment_entry_guard' AND NOT tgisinternal AND tgenabled='O') THEN
    RAISE EXCEPTION 'Financial approval/entry/commit guards are missing';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint c JOIN pg_index i ON i.indexrelid=c.conindid
    WHERE c.conrelid='public.stock_valuation_entries'::regclass AND c.conname='stock_value_posting_unique_1007'
      AND c.contype='u' AND i.indnullsnotdistinct AND cardinality(c.conkey)=6) THEN
    RAISE EXCEPTION 'Physical/opening uniqueness must remain preserved alongside correction UUIDs';
  END IF;
  IF EXISTS(SELECT 1 FROM public.stock_valuation_value_adjustments
    WHERE source_sha256<>encode(digest(source_snapshot::text,'sha256'),'hex') OR source_reliability<>'DECLARED') THEN
    RAISE EXCEPTION 'Financial declaration proof invalid';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.stock_valuation_projector_control
    WHERE singleton AND mode='PREPARED' AND NOT initialized AND last_sequence=0 AND reporting_currency='EUR') THEN
    RAISE EXCEPTION 'Delivery changed the prepared Stock projector';
  END IF;
END $$;
