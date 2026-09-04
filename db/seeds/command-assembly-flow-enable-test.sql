\set ON_ERROR_STOP on

DO $$
BEGIN
  IF current_database() <> 'cerp_test' THEN
    RAISE EXCEPTION 'COMMAND_ASSEMBLY_FLOW can only be enabled globally by this seed on cerp_test';
  END IF;
END;
$$;

UPDATE public.app_feature_flags
SET enabled = true,
    environment = 'test',
    updated_at = now()
WHERE key = 'COMMAND_ASSEMBLY_FLOW';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.app_feature_flags
    WHERE key = 'COMMAND_ASSEMBLY_FLOW'
      AND enabled = true
      AND environment = 'test'
  ) THEN
    RAISE EXCEPTION 'COMMAND_ASSEMBLY_FLOW feature flag was not enabled on cerp_test';
  END IF;
END;
$$;
