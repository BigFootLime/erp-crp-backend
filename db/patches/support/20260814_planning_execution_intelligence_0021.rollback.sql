-- Destructive only for SOL-21 preferences. Export the table or restore the
-- validated backup in production before acknowledging this rollback.
DO $rollback_guard$
BEGIN
  IF current_setting('cerp.sol21_preferences_exported', true) IS DISTINCT FROM 'yes' THEN
    RAISE EXCEPTION 'SOL-21 rollback refused: SET cerp.sol21_preferences_exported = yes after exporting preferences';
  END IF;
END
$rollback_guard$;

BEGIN;
DROP TABLE IF EXISTS public.planning_user_preferences;
DROP FUNCTION IF EXISTS public.fn_planning_color_map_is_valid(jsonb);
COMMIT;
