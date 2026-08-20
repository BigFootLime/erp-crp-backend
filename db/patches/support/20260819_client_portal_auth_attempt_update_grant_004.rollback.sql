\set ON_ERROR_STOP on

-- The exact privilege baseline predating this corrective patch is not
-- reconstructible from PostgreSQL grants alone. Revoke-in-place could remove a
-- permission owned by another approved migration. Restore the verified
-- pre-migration backup after rolling the matching application code back.
DO $rollback$
BEGIN
  RAISE EXCEPTION USING
    MESSAGE = 'CERP-AUDIT-004 portal grant rollback requires restoring the verified pre-migration backup',
    HINT = 'Do not REVOKE in place; restore the backup into an isolated database, verify portal activation, then promote it.';
END
$rollback$;
