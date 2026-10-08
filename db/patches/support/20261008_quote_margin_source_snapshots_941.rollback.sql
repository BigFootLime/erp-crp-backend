-- Keep the additive table and its immutable commercial history. Restoring the
-- previous backend is safe only before new captures exist: it otherwise reads
-- today's costs as if they were the frozen historical offer.
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM public.quote_margin_source_snapshots) THEN
    RAISE EXCEPTION 'Quote captures exist: use a forward fix or the matching database recovery set';
  END IF;
END $$;
