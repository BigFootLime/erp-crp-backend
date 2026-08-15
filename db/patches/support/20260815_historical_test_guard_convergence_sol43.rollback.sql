\set ON_ERROR_STOP on

DO $$
BEGIN
  RAISE EXCEPTION USING
    MESSAGE = 'SOL-43 convergence rollback requires restoring the verified pre-migration custom-format backup into a new database',
    HINT = 'Do not delete supersession evidence or downcast stock quantities in place; validate the restored database, then repoint the previous application release.';
END
$$;
