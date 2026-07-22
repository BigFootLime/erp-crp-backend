\set ON_ERROR_STOP on

DO $$
BEGIN
  IF current_database() <> 'cerp_test' THEN
    RAISE EXCEPTION '#164 rollback is restricted to cerp_test (current=%)', current_database();
  END IF;
  IF EXISTS (SELECT 1 FROM public.article_create_idempotence)
     OR EXISTS (SELECT 1 FROM public.article_procurement_profile)
     OR EXISTS (
       SELECT 1 FROM public.articles
       WHERE designation_secondary IS NOT NULL OR is_sold OR archived_at IS NOT NULL OR archive_reason IS NOT NULL
     )
     OR EXISTS (
       SELECT 1 FROM public.article_documents
       WHERE revision IS NOT NULL OR is_active = false OR retired_at IS NOT NULL
     ) THEN
    RAISE EXCEPTION '#164 rollback refused: post-migration Article data exists';
  END IF;
END $$;

DROP INDEX IF EXISTS public.article_documents_active_idx;
ALTER TABLE public.article_documents
  DROP CONSTRAINT IF EXISTS article_documents_retired_by_fkey,
  DROP COLUMN IF EXISTS retired_by,
  DROP COLUMN IF EXISTS retired_at,
  DROP COLUMN IF EXISTS is_active,
  DROP COLUMN IF EXISTS revision;

DROP TABLE IF EXISTS public.article_procurement_profile;
DROP TABLE IF EXISTS public.article_create_idempotence;

DROP TRIGGER IF EXISTS trg_articles_master_data_guard ON public.articles;
DROP FUNCTION IF EXISTS public.fn_articles_master_data_guard();
DROP INDEX IF EXISTS public.articles_archived_at_idx;
DROP INDEX IF EXISTS public.articles_is_sold_idx;
ALTER TABLE public.articles
  DROP CONSTRAINT IF EXISTS articles_archived_by_fkey,
  DROP CONSTRAINT IF EXISTS articles_row_version_ck,
  DROP COLUMN IF EXISTS archive_reason,
  DROP COLUMN IF EXISTS archived_by,
  DROP COLUMN IF EXISTS archived_at,
  DROP COLUMN IF EXISTS row_version,
  DROP COLUMN IF EXISTS is_sold,
  DROP COLUMN IF EXISTS designation_secondary;

DELETE FROM public.cerp_schema_migrations
WHERE filename = '20260722_articles_164_master_data.sql';
