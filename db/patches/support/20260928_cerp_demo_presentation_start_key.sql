-- CERP demo only: allow separate browser sessions for the same DEMO account.
-- Replays remain idempotent through demo_presentation_start_key_per_user.
BEGIN;
DO $$
BEGIN
  IF current_database() <> 'cerp_demo' THEN
    RAISE EXCEPTION 'This patch is restricted to cerp_demo (current: %)', current_database();
  END IF;
  IF to_regclass('public.demo_presentation_scenarios') IS NULL THEN
    RAISE EXCEPTION 'Presentation scenario registry is missing';
  END IF;
  IF to_regclass('public.demo_presentation_start_key_per_user') IS NULL THEN
    RAISE EXCEPTION 'Presentation start-key uniqueness index is missing';
  END IF;
END
$$;

DROP INDEX IF EXISTS public.demo_presentation_one_active_per_user;
COMMIT;
