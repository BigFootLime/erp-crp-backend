\set ON_ERROR_STOP on

SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'articles'
  AND column_name IN ('designation_secondary','is_sold','row_version','archived_at','archived_by','archive_reason')
ORDER BY column_name;

SELECT to_regclass('public.article_create_idempotence') IS NOT NULL AS has_article_idempotence,
       to_regclass('public.article_procurement_profile') IS NOT NULL AS has_procurement_profile;

SELECT tgname
FROM pg_trigger
WHERE tgrelid = 'public.articles'::regclass
  AND tgname = 'trg_articles_master_data_guard'
  AND NOT tgisinternal;

SELECT filename, applied_at
FROM public.cerp_schema_migrations
WHERE filename = '20260722_articles_164_master_data.sql';
