-- Rollback de la tour de contrôle des accès #326 / back #200.
-- Ne touche AUCUNE ligne de public.users : seule la colonne ajoutée par le patch est
-- retirée. Toute autre donnée de compte est hors du périmètre de ce rollback.
\set ON_ERROR_STOP on

BEGIN;

DO $$
BEGIN
  IF current_database() NOT IN ('cerp_test', 'cerp_prod') THEN
    RAISE EXCEPTION 'Rollback #326 refusé hors cerp_test/cerp_prod (base actuelle : %)',
      current_database();
  END IF;
END
$$;

DROP TRIGGER IF EXISTS trg_app_module_access_events_append_only
  ON public.app_module_access_events;
DROP FUNCTION IF EXISTS public.fn_app_module_access_events_append_only();
DROP TABLE IF EXISTS public.app_module_access_events;
DROP TABLE IF EXISTS public.app_module_user_access;
DROP TABLE IF EXISTS public.app_modules;

ALTER TABLE public.users
  DROP COLUMN IF EXISTS is_superadmin;

COMMIT;
