\set ON_ERROR_STOP on
DO $$ BEGIN
  IF to_regclass('public.client_contracts') IS NULL OR to_regclass('public.carco_reviews') IS NULL THEN
    RAISE EXCEPTION 'Client contracts and CARCO reviews are required';
  END IF;
END $$;
