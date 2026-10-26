-- Local, fail-closed cache of a signed Directory company policy.
BEGIN;
DO $$ BEGIN
 IF current_database() ~ '^cerp_directory_' THEN RAISE EXCEPTION 'Company policy projections belong to a business database'; END IF;
 IF to_regclass('public.users') IS NULL OR to_regclass('public.app_modules') IS NULL THEN RAISE EXCEPTION 'Local identity and access-control prerequisites are required'; END IF;
END $$;
CREATE TABLE IF NOT EXISTS public.cerp_company_policy_projections (
  profile_id uuid NOT NULL,
  company_id uuid NOT NULL,
  environment text NOT NULL CHECK(environment IN ('cerp_prod','cerp_test')),
  target_site text NOT NULL CHECK(target_site IN ('cerp_prod','cerp_test') OR target_site ~ '^cerp_test_[a-f0-9]{32}$' OR target_site ~ '^cerp_company_[a-f0-9]{32}_(prod|test)$'),
  company_version integer NOT NULL CHECK(company_version>0),
  membership_version integer NOT NULL CHECK(membership_version>0),
  instance_version integer NOT NULL CHECK(instance_version>0),
  policy_hash text NOT NULL CHECK(policy_hash ~ '^[a-f0-9]{64}$'),
  projected_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(profile_id,company_id,environment,target_site),
  CHECK((environment='cerp_prod' AND (target_site='cerp_prod' OR target_site ~ '^cerp_company_[a-f0-9]{32}_prod$'))
     OR (environment='cerp_test' AND (target_site='cerp_test' OR target_site ~ '^cerp_test_[a-f0-9]{32}$' OR target_site ~ '^cerp_company_[a-f0-9]{32}_test$')))
);
REVOKE ALL ON public.cerp_company_policy_projections FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON public.cerp_company_policy_projections TO cerp_app;
COMMIT;
