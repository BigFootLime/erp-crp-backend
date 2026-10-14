BEGIN;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.users WHERE directory_profile_id IS NOT NULL) OR EXISTS(SELECT 1 FROM public.cerp_directory_approved_actor_bindings) OR EXISTS(SELECT 1 FROM public.cerp_directory_company_bindings) THEN RAISE EXCEPTION 'Active identity/company projections require coordinated recovery; no destructive rollback'; END IF;
END $$;
DROP TABLE IF EXISTS public.cerp_directory_company_state,public.cerp_directory_company_bindings,public.cerp_directory_actor_state,public.cerp_directory_projection_state,public.cerp_directory_approved_actor_bindings,public.cerp_directory_work_profile_bindings;
ALTER TABLE public.users DROP COLUMN IF EXISTS directory_profile_metadata,DROP COLUMN IF EXISTS directory_avatar_asset_id,DROP COLUMN IF EXISTS directory_email,DROP COLUMN IF EXISTS directory_username,DROP COLUMN IF EXISTS directory_profile_id;
ALTER TABLE public.operator_device_sessions DROP COLUMN IF EXISTS directory_global_epoch,DROP COLUMN IF EXISTS directory_membership_version;
COMMIT;
