\set ON_ERROR_STOP on
DO $$ BEGIN
  IF to_regclass('public.client_open_orders') IS NULL OR to_regclass('public.carco_review_contracts') IS NULL
    OR to_regclass('public.carco_review_schedule_decisions') IS NULL OR NOT EXISTS (
    SELECT FROM pg_constraint WHERE conrelid='public.carco_reviews'::regclass AND conname='carco_review_single_author' AND convalidated
  ) THEN RAISE EXCEPTION 'Missing contract envelopes or deposit provenance'; END IF;
END $$;
