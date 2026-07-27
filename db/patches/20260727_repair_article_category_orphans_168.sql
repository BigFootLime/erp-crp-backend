-- Issue #168 — repair two residual category links left by a deleted recipe article.
--
-- The article creation is still preserved by erp_audit_logs.id = 167. The
-- article itself, its project and its technical piece no longer exist, and no
-- business table other than article_category_link references its UUID.
--
-- Safety properties:
-- - exact source audit, article UUID hash and evidence hashes are pinned;
-- - every article-like reference column is scanned before deletion;
-- - the two original rows are copied to an immutable audit event first;
-- - the deletion and FK validation are one transaction;
-- - reruns are idempotent after the repair has been completed.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

LOCK TABLE public.article_category_link IN SHARE ROW EXCLUSIVE MODE;

DO $repair$
DECLARE
  expected_article_md5 constant text := '454eeddc3ac8518e63994a8d0da03206';
  expected_links_sha256 constant text := '01dfd9678e74320d49b1ec3a727ed3b370e8910a07cffb5b350cbaf4ba7189ac';
  expected_source_sha256 constant text := 'c9b95a94ebcf93041b6f325b84d90e0f8cb3a50b1cbc788c3061d173cef3026d';
  repair_action constant text := 'data.integrity.article_category_link.remove_orphans_168';
  source_audit_id constant bigint := 167;

  target_article_id uuid;
  source_user_id integer;
  source_details jsonb;
  original_links jsonb;
  orphan_article_count integer;
  target_link_count integer;
  existing_repair_count integer;
  reference_count bigint;
  affected integer;
  ref record;
BEGIN
  IF current_database() NOT IN ('cerp_test', 'cerp_prod') THEN
    RAISE EXCEPTION 'Repair #168 is restricted to cerp_test or cerp_prod, current database: %',
      current_database();
  END IF;

  SELECT entity_id::uuid, user_id, details
  INTO STRICT target_article_id, source_user_id, source_details
  FROM public.erp_audit_logs
  WHERE id = source_audit_id
    AND action = 'stock.articles.create'
    AND entity_type = 'articles';

  IF md5(target_article_id::text) <> expected_article_md5 THEN
    RAISE EXCEPTION 'Repair #168 refused: unexpected article identity';
  END IF;

  IF encode(digest(source_details::text, 'sha256'), 'hex') <> expected_source_sha256 THEN
    RAISE EXCEPTION 'Repair #168 refused: source audit details changed';
  END IF;

  IF COALESCE(source_details->>'designation', '') !~* '(test|demo|tmp|essai|recette)' THEN
    RAISE EXCEPTION 'Repair #168 refused: source audit is not identifiable as recipe data';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.articles
    WHERE id = target_article_id
       OR code = source_details->>'code'
  ) THEN
    RAISE EXCEPTION 'Repair #168 refused: the source article or its code now exists';
  END IF;

  IF NULLIF(source_details->>'projet_id', '') IS NULL
     OR EXISTS (
       SELECT 1
       FROM public.affaire
       WHERE id = (source_details->>'projet_id')::bigint
     ) THEN
    RAISE EXCEPTION 'Repair #168 refused: source project state differs from the audited diagnosis';
  END IF;

  SELECT count(DISTINCT link.article_id)::integer
  INTO orphan_article_count
  FROM public.article_category_link AS link
  LEFT JOIN public.articles AS article ON article.id = link.article_id
  WHERE article.id IS NULL;

  SELECT count(*)::integer
  INTO target_link_count
  FROM public.article_category_link
  WHERE article_id = target_article_id;

  SELECT count(*)::integer
  INTO existing_repair_count
  FROM public.erp_audit_logs
  WHERE action = repair_action
    AND entity_id = target_article_id::text;

  IF target_link_count = 0 THEN
    IF orphan_article_count <> 0 OR existing_repair_count <> 1 THEN
      RAISE EXCEPTION
        'Repair #168 refused: empty target is not accompanied by the expected completed repair evidence';
    END IF;

    ALTER TABLE public.article_category_link
      VALIDATE CONSTRAINT article_category_link_article_id_fkey;
    RETURN;
  END IF;

  IF orphan_article_count <> 1 OR target_link_count <> 2 OR existing_repair_count > 1 THEN
    RAISE EXCEPTION
      'Repair #168 refused: expected one orphan article and two links, found % orphan article(s), % link(s)',
      orphan_article_count,
      target_link_count;
  END IF;

  SELECT jsonb_agg(
    jsonb_build_object(
      'category_code', category_code,
      'is_primary', is_primary,
      'created_at', created_at,
      'created_by', created_by
    )
    ORDER BY category_code
  )
  INTO original_links
  FROM public.article_category_link
  WHERE article_id = target_article_id;

  IF encode(digest(original_links::text, 'sha256'), 'hex') <> expected_links_sha256 THEN
    RAISE EXCEPTION 'Repair #168 refused: orphan link evidence changed';
  END IF;

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
    ORDER BY col.table_name, col.column_name
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
            repair_action,
            'data.integrity.article_category_link.rollback_168'
          )
      ) THEN
        RAISE EXCEPTION
          'Repair #168 refused: unexpected audit reference for the target article';
      END IF;
      CONTINUE;
    END IF;

    IF reference_count > 0 THEN
      RAISE EXCEPTION
        'Repair #168 refused: unexpected reference in %.% (% row(s))',
        ref.table_name,
        ref.column_name,
        reference_count;
    END IF;
  END LOOP;

  IF existing_repair_count = 0 THEN
    INSERT INTO public.erp_audit_logs (
      user_id,
      event_type,
      action,
      page_key,
      entity_type,
      entity_id,
      path,
      client_session_id,
      ip,
      user_agent,
      device_type,
      os,
      browser,
      details
    )
    VALUES (
      source_user_id,
      'ACTION',
      repair_action,
      'systeme.data-integrity',
      'articles',
      target_article_id::text,
      'db/patches/20260727_repair_article_category_orphans_168.sql',
      NULL,
      NULL,
      'PostgreSQL controlled patch #168',
      'server',
      NULL,
      NULL,
      jsonb_build_object(
        'issue', 168,
        'reason', 'residual category links from a deleted recipe article',
        'source_create_audit_id', source_audit_id,
        'source_details_sha256', expected_source_sha256,
        'original_links_sha256', expected_links_sha256,
        'original_links', original_links,
        'source_audit_preserved', true
      )
    );

    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
      RAISE EXCEPTION 'Repair #168 refused: repair audit evidence was not inserted';
    END IF;
  ELSE
    IF NOT EXISTS (
      SELECT 1
      FROM public.erp_audit_logs
      WHERE action = repair_action
        AND entity_id = target_article_id::text
        AND details->>'original_links_sha256' = expected_links_sha256
        AND details->>'source_details_sha256' = expected_source_sha256
    ) THEN
      RAISE EXCEPTION 'Repair #168 refused: existing repair evidence does not match';
    END IF;
  END IF;

  DELETE FROM public.article_category_link
  WHERE article_id = target_article_id;

  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 2 THEN
    RAISE EXCEPTION 'Repair #168 refused: expected to remove two links, removed %', affected;
  END IF;

  ALTER TABLE public.article_category_link
    VALIDATE CONSTRAINT article_category_link_article_id_fkey;
END
$repair$;

COMMIT;
