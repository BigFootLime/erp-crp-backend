BEGIN;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.users WHERE directory_profile_id IS NOT NULL) OR EXISTS(SELECT 1 FROM public.cerp_directory_projection_state) OR EXISTS(SELECT 1 FROM public.cerp_directory_approved_actor_bindings) OR EXISTS(SELECT 1 FROM public.cerp_directory_actor_state) OR EXISTS(SELECT 1 FROM public.cerp_directory_work_profile_bindings) THEN RAISE EXCEPTION 'Company directory projection data exists; rollback refused'; END IF;
END $$;
DROP TABLE IF EXISTS public.cerp_directory_work_profile_bindings,public.cerp_directory_actor_state,public.cerp_directory_approved_actor_bindings,public.cerp_directory_projection_state;
DROP INDEX IF EXISTS public.users_directory_profile_1454_uq;
COMMIT;
