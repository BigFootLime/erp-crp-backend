DO $$ BEGIN
  IF to_regclass('public.industrial_article_rules') IS NULL THEN
    RAISE EXCEPTION 'industrial article rules prerequisite is missing';
  END IF;
END $$;
