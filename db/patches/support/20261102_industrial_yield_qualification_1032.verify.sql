DO $$ BEGIN
  IF NOT EXISTS(
    SELECT 1 FROM pg_attribute
     WHERE attrelid='public.industrial_article_rules'::regclass
       AND attname='yield_qualified_at' AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'yield qualification timestamp is missing';
  END IF;
  IF EXISTS(
    SELECT 1 FROM public.industrial_article_rules
     WHERE yield_percent < 100 AND yield_qualified_at IS NULL
  ) THEN
    RAISE EXCEPTION 'explicit historical yields were not qualified';
  END IF;
END $$;
