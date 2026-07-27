BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.users
    WHERE tel_no IS NULL
       OR gender IS NULL
       OR address IS NULL
       OR lane IS NULL
       OR house_no IS NULL
       OR postcode IS NULL
       OR date_of_birth IS NULL
       OR social_security_number IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot restore NOT NULL constraints while incomplete ERP profiles exist';
  END IF;
END $$;

ALTER TABLE public.users
  ALTER COLUMN tel_no SET NOT NULL,
  ALTER COLUMN gender SET NOT NULL,
  ALTER COLUMN address SET NOT NULL,
  ALTER COLUMN lane SET NOT NULL,
  ALTER COLUMN house_no SET NOT NULL,
  ALTER COLUMN postcode SET NOT NULL,
  ALTER COLUMN date_of_birth SET NOT NULL,
  ALTER COLUMN social_security_number SET NOT NULL;

COMMIT;
