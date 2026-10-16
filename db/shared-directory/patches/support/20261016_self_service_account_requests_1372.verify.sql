DO $$
BEGIN
  IF current_database() !~ '^cerp_directory_[a-f0-9]{32}$' THEN
    RAISE EXCEPTION 'Account-request authority verification refused outside a shared-directory database';
  END IF;
  IF to_regclass('public.cerp_directory_account_requests') IS NULL
     OR to_regclass('public.cerp_directory_account_request_events') IS NULL
     OR to_regclass('public.cerp_directory_account_request_mutations') IS NULL THEN
    RAISE EXCEPTION 'Account-request authority schema incomplete';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cerp_app' AND (
    has_table_privilege('cerp_app','public.cerp_directory_account_requests','SELECT')
    OR has_table_privilege('cerp_app','public.cerp_directory_account_request_events','SELECT')
    OR has_table_privilege('cerp_app','public.cerp_directory_account_request_mutations','SELECT')
  )) THEN
    RAISE EXCEPTION 'Business application role must not read authority account requests';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cerp_directory_app' AND NOT (
    has_table_privilege('cerp_directory_app','public.cerp_directory_account_requests','SELECT,INSERT,UPDATE')
    AND has_table_privilege('cerp_directory_app','public.cerp_directory_account_request_events','SELECT,INSERT')
    AND has_table_privilege('cerp_directory_app','public.cerp_directory_account_request_mutations','SELECT,INSERT')
  )) THEN
    RAISE EXCEPTION 'Directory application grants are incomplete';
  END IF;
END $$;
