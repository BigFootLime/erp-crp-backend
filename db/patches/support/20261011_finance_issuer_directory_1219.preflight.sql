DO $$ BEGIN
  IF to_regclass('public.einvoice_directory_verification_commands') IS NULL OR to_regclass('public.finance_legal_mentions') IS NULL THEN
    RAISE EXCEPTION 'Apply electronic invoicing reference-data and legal-mentions migrations first';
  END IF;
  IF NOT has_table_privilege('cerp_app', 'public.finance_legal_mentions', 'SELECT,INSERT,UPDATE') THEN
    RAISE EXCEPTION 'The application role cannot qualify issuer routing';
  END IF;
END $$;
