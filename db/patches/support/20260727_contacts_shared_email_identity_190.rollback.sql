\set ON_ERROR_STOP on

BEGIN;

DO $$
BEGIN
  IF current_database() <> 'cerp_test' THEN
    RAISE EXCEPTION 'Rollback #190 refusé hors cerp_test (base actuelle : %)', current_database();
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.contacts
     WHERE client_id IS NOT NULL
       AND email IS NOT NULL
       AND btrim(email) <> ''
       AND archived_at IS NULL
     GROUP BY client_id, lower(btrim(email))
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Rollback #190 refusé : des personnes du même client partagent désormais un courriel';
  END IF;
END
$$;

DROP INDEX IF EXISTS public.contacts_client_email_identity_active_key;

CREATE UNIQUE INDEX IF NOT EXISTS contacts_client_email_active_key
  ON public.contacts (client_id, lower(btrim(email)))
  WHERE client_id IS NOT NULL
    AND email IS NOT NULL
    AND btrim(email) <> ''
    AND archived_at IS NULL;

COMMIT;
