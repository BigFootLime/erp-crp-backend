DO $$ BEGIN
  IF current_database() !~ '^cerp_directory_[a-f0-9]{32}$'
     OR NOT EXISTS (SELECT 1 FROM public.erp_settings WHERE key='security.mfa_policy' AND value_text IN ('required_for_all','optional'))
     OR EXISTS (SELECT 1 FROM public.users u WHERE NOT u.mfa_required AND (u.is_superadmin OR EXISTS (
       SELECT 1 FROM public.cerp_directory_profiles p JOIN public.cerp_directory_memberships m USING(profile_id)
       WHERE p.user_id=u.id AND m.is_superadmin)))
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.cerp_directory_sessions'::regclass AND conname='cerp_directory_sessions_assurance_1372_ck' AND convalidated)
     OR EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='public.cerp_directory_sessions'::regclass AND attname IN ('mfa_factor_id','mfa_factor_version','mfa_verified_at','mfa_method') AND attnotnull AND NOT attisdropped) THEN
    RAISE EXCEPTION 'Directory optional MFA contract is incomplete';
  END IF;
END $$;
