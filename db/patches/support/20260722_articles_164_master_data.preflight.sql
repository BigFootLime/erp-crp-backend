\set ON_ERROR_STOP on

SELECT current_database() AS database_name, current_user AS database_user;

DO $$
BEGIN
  IF current_database() <> 'cerp_test' THEN
    RAISE EXCEPTION '#164 preflight is restricted to cerp_test (current=%)', current_database();
  END IF;
  IF to_regclass('public.articles') IS NULL
     OR to_regclass('public.article_documents') IS NULL
     OR to_regclass('public.fournisseur_catalogue') IS NULL THEN
    RAISE EXCEPTION '#164 prerequisites are missing';
  END IF;
END $$;

SELECT filename, applied_at
FROM public.cerp_schema_migrations
WHERE filename = '20260722_articles_164_master_data.sql';

SELECT COUNT(*) AS articles_before FROM public.articles;
SELECT COUNT(*) AS article_documents_before FROM public.article_documents;
