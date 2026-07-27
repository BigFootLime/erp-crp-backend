\set ON_ERROR_STOP on

\echo '=== Repair #168 preflight (read-only) ==='

SELECT
  current_database() AS database,
  current_database() IN ('cerp_test', 'cerp_prod') AS allowed_database;

WITH source AS (
  SELECT entity_id::uuid AS article_id, details
  FROM public.erp_audit_logs
  WHERE id = 167
    AND action = 'stock.articles.create'
    AND entity_type = 'articles'
),
links AS (
  SELECT
    source.article_id,
    count(link.*)::integer AS link_count,
    jsonb_agg(
      jsonb_build_object(
        'category_code', link.category_code,
        'is_primary', link.is_primary,
        'created_at', link.created_at,
        'created_by', link.created_by
      )
      ORDER BY link.category_code
    ) AS evidence
  FROM source
  LEFT JOIN public.article_category_link AS link
    ON link.article_id = source.article_id
  GROUP BY source.article_id
)
SELECT
  md5(source.article_id::text) = '454eeddc3ac8518e63994a8d0da03206' AS article_identity_ok,
  links.link_count = 2 AS two_links_ok,
  encode(digest(links.evidence::text, 'sha256'), 'hex')
    = '01dfd9678e74320d49b1ec3a727ed3b370e8910a07cffb5b350cbaf4ba7189ac'
    AS link_evidence_ok,
  encode(digest(source.details::text, 'sha256'), 'hex')
    = 'c9b95a94ebcf93041b6f325b84d90e0f8cb3a50b1cbc788c3061d173cef3026d'
    AS source_audit_ok,
  COALESCE(source.details->>'designation', '') ~* '(test|demo|tmp|essai|recette)'
    AS recipe_data_ok,
  NOT EXISTS (
    SELECT 1 FROM public.articles
    WHERE id = source.article_id OR code = source.details->>'code'
  ) AS article_absent_ok,
  NOT EXISTS (
    SELECT 1 FROM public.affaire
    WHERE id = (source.details->>'projet_id')::bigint
  ) AS source_project_absent_ok
FROM source
JOIN links USING (article_id);

SELECT
  count(DISTINCT link.article_id) AS orphan_article_count,
  count(*) AS orphan_link_count
FROM public.article_category_link AS link
LEFT JOIN public.articles AS article ON article.id = link.article_id
WHERE article.id IS NULL;

SELECT
  fk.convalidated AS article_category_fk_validated
FROM pg_constraint AS fk
WHERE fk.conrelid = 'public.article_category_link'::regclass
  AND fk.conname = 'article_category_link_article_id_fkey';

DO $references$
DECLARE
  target_article_id uuid;
  reference_count bigint;
  ref record;
BEGIN
  SELECT entity_id::uuid
  INTO STRICT target_article_id
  FROM public.erp_audit_logs
  WHERE id = 167
    AND action = 'stock.articles.create'
    AND entity_type = 'articles';

  FOR ref IN
    SELECT col.table_schema, col.table_name, col.column_name
    FROM information_schema.columns AS col
    JOIN information_schema.tables AS relation
      ON relation.table_schema = col.table_schema
     AND relation.table_name = col.table_name
     AND relation.table_type = 'BASE TABLE'
    WHERE col.table_schema = 'public'
      AND (
        col.column_name ILIKE '%article%id%'
        OR col.column_name IN ('entity_id', 'target_id')
      )
  LOOP
    EXECUTE format(
      'SELECT count(*) FROM %I.%I WHERE %I::text = $1',
      ref.table_schema,
      ref.table_name,
      ref.column_name
    )
    INTO reference_count
    USING target_article_id::text;

    IF ref.table_name = 'article_category_link'
       AND ref.column_name = 'article_id'
       AND reference_count = 2 THEN
      CONTINUE;
    END IF;

    IF ref.table_name = 'erp_audit_logs'
       AND ref.column_name = 'entity_id' THEN
      IF reference_count < 1 OR EXISTS (
        SELECT 1
        FROM public.erp_audit_logs
        WHERE entity_id = target_article_id::text
          AND action NOT IN (
            'stock.articles.create',
            'data.integrity.article_category_link.remove_orphans_168',
            'data.integrity.article_category_link.rollback_168'
          )
      ) THEN
        RAISE EXCEPTION
          'Preflight #168 failed: unexpected audit reference for the target article';
      END IF;
      CONTINUE;
    END IF;

    IF reference_count > 0 THEN
      RAISE EXCEPTION
        'Preflight #168 failed: unexpected reference in %.% (% row(s))',
        ref.table_name,
        ref.column_name,
        reference_count;
    END IF;
  END LOOP;
END
$references$;

\echo 'Preflight #168 complete: only the two category links and approved audit history may reference the target.'
