DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.users'::regclass AND attname = 'mfa_required'
      AND atttypid = 'boolean'::regtype AND attnotnull AND NOT attisdropped
  ) OR EXISTS (SELECT 1 FROM public.users WHERE is_superadmin AND NOT mfa_required) THEN
    RAISE EXCEPTION 'Account MFA requirement contract is incomplete';
  END IF;
  IF NOT has_column_privilege('cerp_app', 'public.users', 'mfa_required', 'SELECT')
     OR NOT has_column_privilege('cerp_app', 'public.users', 'mfa_required', 'INSERT')
     OR NOT has_column_privilege('cerp_app', 'public.users', 'mfa_required', 'UPDATE') THEN
    RAISE EXCEPTION 'Account MFA requirement runtime ACL is incomplete';
  END IF;
END $$;
