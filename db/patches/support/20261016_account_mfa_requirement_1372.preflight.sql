DO $$
BEGIN
  IF to_regclass('public.users') IS NULL OR to_regrole('cerp_app') IS NULL THEN
    RAISE EXCEPTION 'Account MFA requirement prerequisites are missing';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.users'::regclass AND attname = 'mfa_required' AND NOT attisdropped
      AND (atttypid <> 'boolean'::regtype OR NOT attnotnull)
  ) THEN
    RAISE EXCEPTION 'Existing users.mfa_required requires manual reconciliation';
  END IF;
END $$;
