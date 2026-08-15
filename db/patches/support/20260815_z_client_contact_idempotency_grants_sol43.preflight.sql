\set ON_ERROR_STOP on

BEGIN TRANSACTION READ ONLY;

DO $$
BEGIN
  IF current_database() NOT IN ('cerp_test', 'cerp_prod')
     AND current_database() !~ '^cerp_restore_[a-z0-9_]+$' THEN
    RAISE EXCEPTION 'SOL-43 contact idempotency grant preflight refused on database %', current_database();
  END IF;
  IF to_regclass('public.client_contact_create_idempotency') IS NULL THEN
    RAISE EXCEPTION 'SOL-43 contact idempotency grant preflight refused: table is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    RAISE EXCEPTION 'SOL-43 contact idempotency grant preflight refused: role cerp_app is missing';
  END IF;
END
$$;

COMMIT;
