-- Additive local projections for the shared directory. No legacy account import.
BEGIN;
DO $$ BEGIN
 IF current_database() NOT IN ('cerp_prod','cerp_test') AND current_database() !~ '^cerp_test_[a-f0-9]{32}$' THEN
  RAISE EXCEPTION 'Shared directory site patch refused on this database';
 END IF;
 IF to_regclass('public.users') IS NULL THEN RAISE EXCEPTION 'Users prerequisite missing'; END IF;
END $$;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS directory_profile_id uuid;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS directory_username text;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS directory_email text;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS directory_avatar_asset_id uuid;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS directory_profile_metadata jsonb;
ALTER TABLE public.operator_device_sessions ADD COLUMN IF NOT EXISTS directory_global_epoch bigint;
ALTER TABLE public.operator_device_sessions ADD COLUMN IF NOT EXISTS directory_membership_version integer;
GRANT SELECT(directory_global_epoch,directory_membership_version),INSERT(directory_global_epoch,directory_membership_version),UPDATE(directory_global_epoch,directory_membership_version) ON public.operator_device_sessions TO cerp_app;
CREATE UNIQUE INDEX IF NOT EXISTS users_directory_profile_1568_uq ON public.users(directory_profile_id) WHERE directory_profile_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS public.cerp_directory_projection_state(
 profile_id uuid PRIMARY KEY,user_id integer NOT NULL UNIQUE REFERENCES public.users(id),
 source_user_id integer NOT NULL,global_session_epoch bigint NOT NULL,membership_version integer NOT NULL,
 mfa_factor_id uuid NOT NULL,mfa_factor_version integer NOT NULL,updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.cerp_directory_approved_actor_bindings(
 profile_id uuid PRIMARY KEY,user_id integer NOT NULL UNIQUE REFERENCES public.users(id),
 directory_id uuid NOT NULL,expected_username text NOT NULL,expected_email text NOT NULL,
 approved_command_id uuid NOT NULL,approved_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON public.cerp_directory_approved_actor_bindings FROM PUBLIC,cerp_app;
GRANT SELECT ON public.cerp_directory_approved_actor_bindings TO cerp_app;
GRANT SELECT,INSERT,UPDATE ON public.cerp_directory_projection_state TO cerp_app;
CREATE TABLE IF NOT EXISTS public.cerp_directory_actor_state(profile_id uuid PRIMARY KEY,user_id integer NOT NULL UNIQUE REFERENCES public.users(id),global_session_epoch bigint NOT NULL,membership_version integer NOT NULL,updated_at timestamptz NOT NULL DEFAULT now());
GRANT SELECT,INSERT,UPDATE ON public.cerp_directory_actor_state TO cerp_app;
CREATE TABLE IF NOT EXISTS public.cerp_directory_work_profile_bindings(profile_id uuid PRIMARY KEY,user_id integer NOT NULL UNIQUE REFERENCES public.users(id),projected_at timestamptz NOT NULL DEFAULT now());
GRANT SELECT,INSERT ON public.cerp_directory_work_profile_bindings TO cerp_app;
CREATE TABLE IF NOT EXISTS public.cerp_directory_company_bindings(biller_id uuid PRIMARY KEY REFERENCES public.factureur(biller_id));
CREATE TABLE IF NOT EXISTS public.cerp_directory_company_state(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),revision integer NOT NULL,updated_at timestamptz NOT NULL DEFAULT now());
GRANT SELECT,INSERT ON public.cerp_directory_company_bindings TO cerp_app;
GRANT SELECT,INSERT,UPDATE ON public.cerp_directory_company_state TO cerp_app;
GRANT SELECT(directory_profile_id,directory_username,directory_email),INSERT(directory_profile_id,directory_username,directory_email),UPDATE(directory_profile_id,directory_username,directory_email) ON public.users TO cerp_app;
GRANT SELECT(directory_avatar_asset_id),INSERT(directory_avatar_asset_id),UPDATE(directory_avatar_asset_id) ON public.users TO cerp_app;
GRANT SELECT(directory_profile_metadata),INSERT(directory_profile_metadata),UPDATE(directory_profile_metadata) ON public.users TO cerp_app;
COMMIT;
