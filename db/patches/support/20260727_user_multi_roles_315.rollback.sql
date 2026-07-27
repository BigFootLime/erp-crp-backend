BEGIN;

DROP TRIGGER IF EXISTS trg_user_role_events_append_only
  ON public.user_role_assignment_events;
DROP FUNCTION IF EXISTS public.fn_user_role_events_append_only();
DROP TABLE IF EXISTS public.user_role_assignment_events;
DROP TABLE IF EXISTS public.user_role_assignments;
DROP TABLE IF EXISTS public.app_roles;

COMMIT;
