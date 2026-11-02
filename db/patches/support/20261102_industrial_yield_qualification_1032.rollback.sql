BEGIN;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM public.industrial_article_rules WHERE yield_qualified_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Retain qualified yield evidence; use a forward migration';
  END IF;
END $$;
ALTER TABLE public.industrial_article_rules DROP COLUMN IF EXISTS yield_qualified_at;
COMMIT;
