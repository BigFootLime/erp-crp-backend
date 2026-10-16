DO $$ BEGIN
  IF to_regclass('public.cerp_directory_projection_state') IS NULL THEN
    RAISE EXCEPTION 'Directory projection prerequisite is missing';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cerp_directory_projection_state
      WHERE (mfa_factor_id IS NULL) <> (mfa_factor_version IS NULL) OR mfa_factor_version<=0) THEN
    RAISE EXCEPTION 'Directory projection assurance must be reconciled before migration';
  END IF;
END $$;
