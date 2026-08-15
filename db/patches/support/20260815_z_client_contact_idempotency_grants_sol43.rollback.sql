\set ON_ERROR_STOP on

DO $$
BEGIN
  RAISE EXCEPTION USING
    MESSAGE = 'SOL-43 contact idempotency grant rollback requires restoring the verified pre-migration backup',
    HINT = 'The test database already had these privileges; revoking them in place would not restore a known prior state.';
END
$$;
