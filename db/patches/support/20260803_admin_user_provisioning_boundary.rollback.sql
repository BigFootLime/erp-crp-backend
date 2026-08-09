-- Rollback for GPT56-CERP-0001-A. Human approval is mandatory.
-- It restores only NOT NULL constraints that were present before the forward patch.
-- It aborts without partial effects if a newly incomplete profile prevents restoration.

BEGIN;

DO $$
DECLARE
  state RECORD;
  has_null BOOLEAN;
BEGIN
  IF to_regclass('public.admin_user_provisioning_migration_state') IS NULL THEN
    RAISE EXCEPTION 'Missing migration state; refusing an unsafe rollback';
  END IF;

  FOR state IN
    SELECT column_name
    FROM public.admin_user_provisioning_migration_state
    WHERE was_not_null
  LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.users WHERE %I IS NULL)', state.column_name)
      INTO has_null;
    IF has_null THEN
      RAISE EXCEPTION 'Column users.% contains NULL values; complete/reconcile profiles before rollback',
        state.column_name;
    END IF;
    EXECUTE format('ALTER TABLE public.users ALTER COLUMN %I SET NOT NULL', state.column_name);
  END LOOP;
END $$;

DROP TABLE IF EXISTS public.admin_user_provisioning_requests;
DROP TABLE IF EXISTS public.admin_user_provisioning_migration_state;

COMMIT;
