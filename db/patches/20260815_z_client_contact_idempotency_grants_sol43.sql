-- SOL-43 — grant only the privileges required by the contact idempotency
-- repository after the production-safe historical convergence created it.

BEGIN;

DO $$
BEGIN
  IF current_database() NOT IN ('cerp_test', 'cerp_prod')
     AND current_database() !~ '^cerp_restore_[a-z0-9_]+$' THEN
    RAISE EXCEPTION 'SOL-43 contact idempotency grant refused on database %', current_database();
  END IF;
  IF to_regclass('public.client_contact_create_idempotency') IS NULL THEN
    RAISE EXCEPTION 'SOL-43 contact idempotency grant refused: table is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    RAISE EXCEPTION 'SOL-43 contact idempotency grant refused: role cerp_app is missing';
  END IF;
END
$$;

GRANT SELECT, INSERT
  ON TABLE public.client_contact_create_idempotency
  TO cerp_app;

COMMIT;
