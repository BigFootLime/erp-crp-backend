DO $$ DECLARE relation_name text; BEGIN
 IF to_regclass('public.cerp_business_companies') IS NULL OR to_regclass('public.cerp_business_company_memberships') IS NULL OR to_regclass('public.cerp_business_company_instances') IS NULL OR to_regclass('public.cerp_business_company_switches') IS NULL THEN RAISE EXCEPTION '1454 registry relations missing'; END IF;
 FOREACH relation_name IN ARRAY ARRAY['cerp_business_companies','cerp_business_company_memberships','cerp_business_company_instances','cerp_business_company_switches'] LOOP
  IF NOT (has_table_privilege('cerp_directory_app','public.'||relation_name,'SELECT') AND has_table_privilege('cerp_directory_app','public.'||relation_name,'INSERT') AND has_table_privilege('cerp_directory_app','public.'||relation_name,'UPDATE')) THEN RAISE EXCEPTION '1454 directory role privileges missing'; END IF;
  IF has_table_privilege('cerp_app','public.'||relation_name,'SELECT,INSERT,UPDATE,DELETE') THEN RAISE EXCEPTION '1454 registry must remain private to Directory'; END IF;
 END LOOP;
 IF NOT has_table_privilege('cerp_directory_app','public.cerp_business_company_switches','DELETE') THEN RAISE EXCEPTION '1454 bounded ticket maintenance privilege missing'; END IF;
END $$;
SELECT company_id,code,profile,status,version FROM public.cerp_business_companies ORDER BY code;
SELECT count(*)::int AS active_unredeemed_switches FROM public.cerp_business_company_switches WHERE expires_at>now() AND redeemed_at IS NULL;
