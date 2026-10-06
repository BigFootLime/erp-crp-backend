\set ON_ERROR_STOP on
BEGIN READ ONLY;
SELECT current_database(), current_user;
DO $$ DECLARE definition text; BEGIN
  SELECT pg_get_functiondef('public.fn_guard_preparation_execution_712()'::regprocedure) INTO definition;
  IF definition NOT LIKE '%execution AND NOT EXISTS%of_self_inspection_sheets%'
    OR definition NOT LIKE '%OF_DOSSIER_REQUIRED%'
    OR definition NOT LIKE '%execution_programming%'
    OR definition NOT LIKE '%OF_PROGRAMMING_REQUIRED%' THEN
    RAISE EXCEPTION 'Preparation before planning / execution guards do not match the release';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.planning_events'::regclass AND tgname='of_dossier_planning_changed') THEN
    RAISE EXCEPTION 'Planning still invalidates technical dossier completeness';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgfoid='public.fn_guard_preparation_execution_712()'::regprocedure AND NOT tgisinternal AND tgenabled<>'D') <> 6 THEN
    RAISE EXCEPTION 'One of the six execution/preparation guards is absent or disabled';
  END IF;
END $$;
SET LOCAL ROLE cerp_app;
SELECT count(*) AS readable_validations FROM public.of_dossier_validations;
SELECT count(*) AS readable_sheets FROM public.of_self_inspection_sheets;
COMMIT;
