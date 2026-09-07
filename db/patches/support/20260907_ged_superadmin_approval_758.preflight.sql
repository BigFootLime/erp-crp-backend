\set ON_ERROR_STOP on
SELECT current_database() AS database, to_regprocedure('public.fn_ged_version_separation_of_duties()') AS policy;
SELECT pg_get_functiondef('public.fn_ged_version_separation_of_duties()'::regprocedure);
SELECT id, username, is_superadmin, status FROM public.users WHERE upper(username)='KEENAN';
SELECT tgname,tgenabled FROM pg_trigger WHERE tgrelid='public.ged_document_versions'::regclass AND NOT tgisinternal;
