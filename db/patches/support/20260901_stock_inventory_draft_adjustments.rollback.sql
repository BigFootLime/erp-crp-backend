\set ON_ERROR_STOP on

DO $$
BEGIN
  RAISE EXCEPTION USING
    MESSAGE = 'Inventory draft-adjustment rollback requires restoring the verified pre-migration backup into a new database',
    HINT = 'Do not remove inventory-to-movement evidence in place; validate the restored database, then repoint the previous application release.';
END
$$;
