-- Safe rollback guidance for 20261021_shared_planning_client_color.sql.
-- This patch is additive. Do not drop its column as a routine rollback: even a
-- NULL value records an explicit reset and a later replay could backfill it.
-- Roll back the application release while retaining this compatible column.

BEGIN;
DO $$
BEGIN
  IF current_setting('cerp.confirm_shared_client_color_rollback', true) IS DISTINCT FROM 'APPROVED' THEN
    RAISE EXCEPTION 'Set cerp.confirm_shared_client_color_rollback=APPROVED only after human validation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid='public.clients'::regclass AND attname='planning_color_hex' AND NOT attisdropped
  ) THEN
    RAISE NOTICE 'Shared planning color column is already absent; no schema action is required.';
    RETURN;
  END IF;
  RAISE NOTICE 'No destructive schema rollback was performed. Keep planning_color_hex to preserve shared colors and explicit resets; roll back only the application release.';
END $$;
COMMIT;
