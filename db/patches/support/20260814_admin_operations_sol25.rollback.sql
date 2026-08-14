\set ON_ERROR_STOP on

-- Application rollback is the normal strategy: the previous binary ignores every
-- additive object below. Physical removal is intentionally guarded because review
-- decisions are audit evidence and must not be erased accidentally.
DO $guard$
BEGIN
  IF current_setting('cerp.allow_destructive_rollback', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION
      'Physical SOL-25 rollback disabled. Roll back the application first; set cerp.allow_destructive_rollback=on only after exporting review evidence.';
  END IF;
END
$guard$;

BEGIN;

DROP TABLE IF EXISTS public.app_access_review_items;
DROP TABLE IF EXISTS public.app_access_reviews;

ALTER TABLE public.app_notifications
  DROP CONSTRAINT IF EXISTS app_notifications_action_url_internal_ck,
  DROP CONSTRAINT IF EXISTS app_notifications_escalation_level_ck,
  DROP CONSTRAINT IF EXISTS app_notifications_entity_pair_ck,
  DROP CONSTRAINT IF EXISTS app_notifications_expiry_ck,
  DROP COLUMN IF EXISTS entity_type,
  DROP COLUMN IF EXISTS entity_id,
  DROP COLUMN IF EXISTS action_key,
  DROP COLUMN IF EXISTS module_key,
  DROP COLUMN IF EXISTS expires_at,
  DROP COLUMN IF EXISTS muted_until,
  DROP COLUMN IF EXISTS escalated_at,
  DROP COLUMN IF EXISTS escalation_level,
  DROP COLUMN IF EXISTS state_updated_at,
  DROP COLUMN IF EXISTS state_updated_by;

COMMIT;
