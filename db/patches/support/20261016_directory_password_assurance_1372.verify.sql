DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.cerp_directory_projection_state'::regclass AND conname='cerp_directory_projection_assurance_1372_ck' AND convalidated)
     OR EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='public.cerp_directory_projection_state'::regclass AND attname IN ('mfa_factor_id','mfa_factor_version') AND attnotnull AND NOT attisdropped) THEN
    RAISE EXCEPTION 'Directory password projection contract is incomplete';
  END IF;
END $$;
