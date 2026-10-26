-- Central Business Companies registry. Directory authority only; no tenant DB provisioning.
BEGIN;
DO $$ BEGIN
  IF current_database() !~ '^cerp_directory_[a-f0-9]{32}$' THEN RAISE EXCEPTION 'Business companies registry must run in the private Directory'; END IF;
  IF to_regclass('public.cerp_directory_profiles') IS NULL OR to_regclass('public.erp_audit_logs') IS NULL THEN RAISE EXCEPTION 'Directory profile and audit prerequisites are required'; END IF;
END $$;
DO $$
DECLARE legacy_constraint text;
BEGIN
  SELECT conname INTO legacy_constraint
  FROM pg_constraint
  WHERE conrelid='public.cerp_directory_memberships'::regclass
    AND contype='c'
    AND conkey[1]=(SELECT attnum FROM pg_attribute WHERE attrelid='public.cerp_directory_memberships'::regclass AND attname='database_id' AND NOT attisdropped)
    AND array_length(conkey,1)=1;
  IF legacy_constraint IS NULL THEN
    RAISE EXCEPTION 'Directory membership site-id constraint prerequisite is missing';
  END IF;
  EXECUTE format('ALTER TABLE public.cerp_directory_memberships DROP CONSTRAINT %I', legacy_constraint);
  ALTER TABLE public.cerp_directory_memberships ADD CONSTRAINT cerp_directory_memberships_database_id_ck_1454
    CHECK(database_id IN ('cerp_prod','cerp_test')
      OR database_id~'^cerp_test_[a-f0-9]{32}$'
      OR database_id~'^cerp_company_[a-f0-9]{32}_(prod|test)$');
END $$;
CREATE TABLE IF NOT EXISTS public.cerp_business_companies(
  company_id uuid PRIMARY KEY,
  code text NOT NULL CHECK(code ~ '^[A-Z0-9-]{2,32}$'),
  name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 200),
  profile text NOT NULL CHECK(profile IN ('COMMERCIAL','INDUSTRIAL')),
  status text NOT NULL CHECK(status IN ('ACTIVE','SUSPENDED','RETIRED')),
  enabled_module_keys text[] NOT NULL DEFAULT '{}'::text[] CHECK(array_position(enabled_module_keys,NULL) IS NULL),
  enabled_commercial_projection_capabilities text[] NOT NULL DEFAULT '{}'::text[] CHECK(array_position(enabled_commercial_projection_capabilities,NULL) IS NULL),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  created_by_user_id integer NOT NULL REFERENCES public.users(id), updated_by_user_id integer NOT NULL REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT business_companies_commercial_modules_ck CHECK(profile<>'COMMERCIAL' OR NOT(enabled_module_keys && ARRAY['stock','livraisons','production','planning','ged','pieces-techniques','outillage']::text[])),
  CONSTRAINT business_companies_known_modules_ck CHECK(enabled_module_keys <@ ARRAY['clients','devis','commandes-clients','livraisons','affaires','facturation','reporting-commercial','fournisseurs','commandes-fournisseurs','pieces-techniques','finitions','methodes-centres-frais','methodes-parc-machines','production','planning','qualite','metrologie','tracabilite','stock','outillage','temps-deplacements','pilotage-projet','import-clipper','ged','parametrage-erp','administration']::text[]),
  CONSTRAINT business_companies_commercial_projection_ck CHECK(profile='COMMERCIAL' OR cardinality(enabled_commercial_projection_capabilities)=0),
  CONSTRAINT business_companies_projection_values_ck CHECK(enabled_commercial_projection_capabilities <@ ARRAY['stock.projection.read','livraisons.projection.read']::text[])
);
CREATE UNIQUE INDEX IF NOT EXISTS cerp_business_companies_code_uq ON public.cerp_business_companies(code);
CREATE TABLE IF NOT EXISTS public.cerp_business_company_memberships(
  company_id uuid NOT NULL REFERENCES public.cerp_business_companies(company_id), profile_id uuid NOT NULL REFERENCES public.cerp_directory_profiles(profile_id),
  status text NOT NULL CHECK(status IN ('ACTIVE','SUSPENDED','REVOKED')),
  allowed_module_keys text[] NOT NULL DEFAULT '{}'::text[] CHECK(array_position(allowed_module_keys,NULL) IS NULL),
  denied_module_keys text[] NOT NULL DEFAULT '{}'::text[] CHECK(array_position(denied_module_keys,NULL) IS NULL),
  enabled_commercial_projection_capabilities text[] NOT NULL DEFAULT '{}'::text[] CHECK(enabled_commercial_projection_capabilities <@ ARRAY['stock.projection.read','livraisons.projection.read']::text[]),
  version integer NOT NULL DEFAULT 1 CHECK(version>0), created_by_user_id integer NOT NULL REFERENCES public.users(id), updated_by_user_id integer NOT NULL REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(company_id,profile_id),
  CONSTRAINT business_company_memberships_known_modules_ck CHECK(denied_module_keys <@ ARRAY['clients','devis','commandes-clients','livraisons','affaires','facturation','reporting-commercial','fournisseurs','commandes-fournisseurs','pieces-techniques','finitions','methodes-centres-frais','methodes-parc-machines','production','planning','qualite','metrologie','tracabilite','stock','outillage','temps-deplacements','pilotage-projet','import-clipper','ged','parametrage-erp','administration']::text[]),
  CONSTRAINT business_company_memberships_allowed_modules_ck CHECK(allowed_module_keys <@ ARRAY['clients','devis','commandes-clients','livraisons','affaires','facturation','reporting-commercial','fournisseurs','commandes-fournisseurs','pieces-techniques','finitions','methodes-centres-frais','methodes-parc-machines','production','planning','qualite','metrologie','tracabilite','stock','outillage','temps-deplacements','pilotage-projet','import-clipper','ged','parametrage-erp','administration']::text[])
);
CREATE TABLE IF NOT EXISTS public.cerp_business_company_instances(
  company_id uuid NOT NULL REFERENCES public.cerp_business_companies(company_id), environment text NOT NULL CHECK(environment IN ('cerp_prod','cerp_test')),
  site_id text NOT NULL CHECK(site_id IN ('cerp_prod','cerp_test') OR site_id ~ '^cerp_test_[a-f0-9]{32}$' OR site_id ~ '^cerp_company_[a-f0-9]{32}_(prod|test)$'), active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK(version>0), created_by_user_id integer NOT NULL REFERENCES public.users(id), updated_by_user_id integer NOT NULL REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(company_id,environment), UNIQUE(site_id),
  CONSTRAINT business_company_instance_environment_site_ck CHECK(
    (environment='cerp_prod' AND (site_id='cerp_prod' OR site_id ~ '^cerp_company_[a-f0-9]{32}_prod$'))
    OR (environment='cerp_test' AND (site_id='cerp_test' OR site_id ~ '^cerp_test_[a-f0-9]{32}$' OR site_id ~ '^cerp_company_[a-f0-9]{32}_test$'))
  )
);
REVOKE ALL ON public.cerp_business_companies,public.cerp_business_company_memberships,public.cerp_business_company_instances FROM PUBLIC,cerp_app;
GRANT SELECT,INSERT,UPDATE ON public.cerp_business_companies,public.cerp_business_company_memberships,public.cerp_business_company_instances TO cerp_directory_app;
CREATE TABLE IF NOT EXISTS public.cerp_business_company_switches(
 ticket_hash text PRIMARY KEY CHECK(ticket_hash ~ '^[a-f0-9]{64}$'),
 request_key uuid NOT NULL, source_session_hash text NOT NULL CHECK(source_session_hash ~ '^[a-f0-9]{64}$'),
 profile_id uuid NOT NULL REFERENCES public.cerp_directory_profiles(profile_id), source_site text NOT NULL, target_site text NOT NULL,
 company_id uuid NOT NULL REFERENCES public.cerp_business_companies(company_id), environment text NOT NULL CHECK(environment IN ('cerp_prod','cerp_test')),
 global_session_epoch bigint NOT NULL, source_membership_version integer NOT NULL, source_company_membership_version integer NOT NULL, company_membership_version integer NOT NULL, target_directory_membership_version integer NOT NULL,
 expires_at timestamptz NOT NULL, redeemed_at timestamptz NULL, redeemed_session_hash text NULL CHECK(redeemed_session_hash IS NULL OR redeemed_session_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(source_session_hash,request_key)
);
CREATE INDEX IF NOT EXISTS cerp_business_company_switches_expiry_idx ON public.cerp_business_company_switches(expires_at);
REVOKE ALL ON public.cerp_business_company_switches FROM PUBLIC,cerp_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.cerp_business_company_switches TO cerp_directory_app;
COMMIT;
