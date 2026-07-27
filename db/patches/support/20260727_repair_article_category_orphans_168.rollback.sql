\set ON_ERROR_STOP on

BEGIN;

DO $guard$
BEGIN
  IF current_database() <> 'cerp_test' THEN
    RAISE EXCEPTION 'Rollback #168 is restricted to cerp_test';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.erp_audit_logs
    WHERE action = 'data.integrity.article_category_link.remove_orphans_168'
      AND details->>'original_links_sha256'
        = '01dfd9678e74320d49b1ec3a727ed3b370e8910a07cffb5b350cbaf4ba7189ac'
  ) THEN
    RAISE EXCEPTION 'Rollback #168 refused: repair evidence is missing or changed';
  END IF;
END
$guard$;

LOCK TABLE public.article_category_link IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE public.article_category_link
  DROP CONSTRAINT article_category_link_article_id_fkey;

DO $restore$
DECLARE
  repair_audit public.erp_audit_logs%ROWTYPE;
  original_link jsonb;
  restored integer := 0;
BEGIN
  SELECT *
  INTO STRICT repair_audit
  FROM public.erp_audit_logs
  WHERE action = 'data.integrity.article_category_link.remove_orphans_168'
  ORDER BY id
  LIMIT 1;

  IF EXISTS (
    SELECT 1
    FROM public.article_category_link
    WHERE article_id = repair_audit.entity_id::uuid
  ) THEN
    RAISE EXCEPTION 'Rollback #168 refused: target links already exist';
  END IF;

  FOR original_link IN
    SELECT value
    FROM jsonb_array_elements(repair_audit.details->'original_links')
  LOOP
    INSERT INTO public.article_category_link (
      article_id,
      category_code,
      is_primary,
      created_at,
      created_by
    )
    VALUES (
      repair_audit.entity_id::uuid,
      original_link->>'category_code',
      (original_link->>'is_primary')::boolean,
      (original_link->>'created_at')::timestamptz,
      (original_link->>'created_by')::integer
    );
    restored := restored + 1;
  END LOOP;

  IF restored <> 2 THEN
    RAISE EXCEPTION 'Rollback #168 refused: expected two restored links, restored %', restored;
  END IF;

  INSERT INTO public.erp_audit_logs (
    user_id,
    event_type,
    action,
    page_key,
    entity_type,
    entity_id,
    path,
    details
  )
  VALUES (
    repair_audit.user_id,
    'ACTION',
    'data.integrity.article_category_link.rollback_168',
    'systeme.data-integrity',
    'articles',
    repair_audit.entity_id,
    'db/patches/support/20260727_repair_article_category_orphans_168.rollback.sql',
    jsonb_build_object(
      'issue', 168,
      'repair_audit_id', repair_audit.id,
      'restored_links', restored,
      'test_only', true
    )
  );
END
$restore$;

ALTER TABLE public.article_category_link
  ADD CONSTRAINT article_category_link_article_id_fkey
  FOREIGN KEY (article_id)
  REFERENCES public.articles(id)
  ON DELETE CASCADE
  NOT VALID;

COMMIT;
