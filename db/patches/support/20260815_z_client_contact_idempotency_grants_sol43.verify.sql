\set ON_ERROR_STOP on

BEGIN TRANSACTION READ ONLY;

DO $$
BEGIN
  IF NOT has_table_privilege('cerp_app', 'public.client_contact_create_idempotency', 'SELECT')
     OR NOT has_table_privilege('cerp_app', 'public.client_contact_create_idempotency', 'INSERT') THEN
    RAISE EXCEPTION 'SOL-43 contact idempotency grant verification failed';
  END IF;
END
$$;

COMMIT;
