DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'public.einvoice_directory_verification_commands'::regclass
      AND conname = 'einvoice_directory_verification_resource_599_ck'
      AND pg_get_constraintdef(oid) LIKE '%ISSUER%'
  ) THEN RAISE EXCEPTION 'Issuer directory qualification constraint is missing'; END IF;
END $$;
