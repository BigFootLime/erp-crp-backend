\set ON_ERROR_STOP on

\echo '=== Repair #168 verification ==='

WITH target AS (
  SELECT entity_id::uuid AS article_id
  FROM public.erp_audit_logs
  WHERE id = 167
    AND action = 'stock.articles.create'
    AND entity_type = 'articles'
)
SELECT
  current_database() AS database,
  EXISTS (
    SELECT 1
    FROM target
    WHERE md5(article_id::text) = '454eeddc3ac8518e63994a8d0da03206'
  ) AS article_identity_ok,
  NOT EXISTS (
    SELECT 1
    FROM public.article_category_link AS link
    LEFT JOIN public.articles AS article ON article.id = link.article_id
    WHERE article.id IS NULL
  ) AS no_orphan_category_links,
  NOT EXISTS (
    SELECT 1
    FROM public.article_category_link AS link
    JOIN target ON target.article_id = link.article_id
  ) AS target_links_removed,
  EXISTS (
    SELECT 1
    FROM public.erp_audit_logs AS audit
    JOIN target ON audit.entity_id = target.article_id::text
    WHERE audit.action = 'data.integrity.article_category_link.remove_orphans_168'
      AND audit.event_type = 'ACTION'
      AND audit.details->>'original_links_sha256'
        = '01dfd9678e74320d49b1ec3a727ed3b370e8910a07cffb5b350cbaf4ba7189ac'
      AND audit.details->>'source_details_sha256'
        = 'c9b95a94ebcf93041b6f325b84d90e0f8cb3a50b1cbc788c3061d173cef3026d'
      AND jsonb_array_length(audit.details->'original_links') = 2
  ) AS repair_evidence_ok;

SELECT
  fk.convalidated AS article_category_fk_validated
FROM pg_constraint AS fk
WHERE fk.conrelid = 'public.article_category_link'::regclass
  AND fk.conname = 'article_category_link_article_id_fkey';

SELECT
  count(*) FILTER (WHERE NOT fk.convalidated) = 0 AS all_public_foreign_keys_validated
FROM pg_constraint AS fk
WHERE fk.contype = 'f'
  AND fk.connamespace = 'public'::regnamespace;
