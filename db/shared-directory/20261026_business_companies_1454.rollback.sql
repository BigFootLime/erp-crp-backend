DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.cerp_business_companies) OR EXISTS(SELECT 1 FROM public.cerp_business_company_memberships) OR EXISTS(SELECT 1 FROM public.cerp_business_company_instances) OR EXISTS(SELECT 1 FROM public.cerp_business_company_switches)
    OR EXISTS(SELECT 1 FROM public.erp_audit_logs WHERE entity_type IN ('business_company','business_company_membership','business_company_instance')) THEN
   RAISE EXCEPTION '1454 rollback refused: registry or audit evidence exists';
 END IF;
 IF EXISTS(SELECT 1 FROM public.cerp_directory_memberships WHERE database_id~'^cerp_company_[a-f0-9]{32}_(prod|test)$') THEN
   RAISE EXCEPTION '1454 rollback refused: business company Directory memberships exist';
 END IF;
END $$;
ALTER TABLE public.cerp_directory_memberships DROP CONSTRAINT IF EXISTS cerp_directory_memberships_database_id_ck_1454;
ALTER TABLE public.cerp_directory_memberships ADD CONSTRAINT cerp_directory_memberships_database_id_ck_1454
  CHECK(database_id IN ('cerp_prod','cerp_test') OR database_id~'^cerp_test_[a-f0-9]{32}$');
DROP TABLE IF EXISTS public.cerp_business_company_switches;
DROP TABLE IF EXISTS public.cerp_business_company_instances;
DROP TABLE IF EXISTS public.cerp_business_company_memberships;
DROP TABLE IF EXISTS public.cerp_business_companies;
