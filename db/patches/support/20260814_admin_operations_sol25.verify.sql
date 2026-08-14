\set ON_ERROR_STOP on

DO $verify$
DECLARE
  missing_columns integer;
BEGIN
  IF to_regclass('public.app_access_reviews') IS NULL
     OR to_regclass('public.app_access_review_items') IS NULL THEN
    RAISE EXCEPTION 'SOL-25 access-review tables are missing';
  END IF;

  SELECT count(*) INTO missing_columns
  FROM (VALUES
    ('entity_type'), ('entity_id'), ('action_key'), ('module_key'), ('expires_at'),
    ('muted_until'), ('escalated_at'), ('escalation_level'), ('state_updated_at'),
    ('state_updated_by')
  ) expected(column_name)
  WHERE NOT EXISTS (
    SELECT 1
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.table_name = 'app_notifications'
      AND c.column_name = expected.column_name
  );

  IF missing_columns <> 0 THEN
    RAISE EXCEPTION 'SOL-25 notification columns missing: %', missing_columns;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.app_access_review_items
    WHERE (decision IS NULL) IS DISTINCT FROM (decided_at IS NULL)
  ) THEN
    RAISE EXCEPTION 'SOL-25 access-review decision integrity failed';
  END IF;

  IF (SELECT count(*) FROM public.app_access_reviews WHERE status = 'OPEN') > 1 THEN
    RAISE EXCEPTION 'SOL-25 permits at most one open access review';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.app_notifications
    WHERE (entity_type IS NULL) IS DISTINCT FROM (entity_id IS NULL)
  ) THEN
    RAISE EXCEPTION 'SOL-25 notification entity pair integrity failed';
  END IF;
END
$verify$;

SELECT
  (SELECT count(*) FROM public.app_access_reviews) AS reviews,
  (SELECT count(*) FROM public.app_access_review_items) AS review_items,
  (SELECT count(*) FROM public.app_notifications WHERE expires_at IS NOT NULL) AS expiring_notifications,
  (SELECT count(*) FROM public.app_notifications WHERE entity_type IS NOT NULL) AS entity_linked_notifications,
  (SELECT count(*) FROM public.app_notifications WHERE escalation_level > 0) AS escalated_notifications;
