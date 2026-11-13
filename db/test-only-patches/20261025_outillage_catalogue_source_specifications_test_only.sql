-- Test-only catalogue import extension. Do not register this patch in the
-- production/template immutable patch runner.
DO $$
BEGIN
  IF current_database() <> 'cerp_test' THEN
    RAISE EXCEPTION '20261025 catalogue import specifications is restricted to cerp_test';
  END IF;
END $$;
ALTER TABLE public.gestion_outils_catalogue_provenance
  ADD COLUMN IF NOT EXISTS source_specifications jsonb NULL;
