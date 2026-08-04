\set ON_ERROR_STOP on

-- Guarded compensation for an unused test installation only.
BEGIN;

DO $$
BEGIN
  IF current_database() <> 'cerp_test' THEN
    RAISE EXCEPTION 'SEC-CERP-0004 rollback is restricted to cerp_test (current: %)', current_database();
  END IF;
  IF to_regclass('public.realtime_event_log') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.realtime_event_log) THEN
    RAISE EXCEPTION 'SEC-CERP-0004 rollback refused: retained realtime events exist';
  END IF;
END $$;

DROP TRIGGER IF EXISTS user_role_assignments_realtime_session_trg ON public.user_role_assignments;
DROP TRIGGER IF EXISTS users_realtime_session_delete_trg ON public.users;
DROP TRIGGER IF EXISTS users_realtime_session_update_trg ON public.users;
DROP FUNCTION IF EXISTS public.cerp_realtime_bump_session_epoch();
DROP TABLE IF EXISTS public.realtime_event_log;
DROP TABLE IF EXISTS public.realtime_session_epochs;

COMMIT;
