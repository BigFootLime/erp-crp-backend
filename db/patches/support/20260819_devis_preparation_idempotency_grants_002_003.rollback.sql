\set ON_ERROR_STOP on

-- No REVOKE is safe here: the pre-migration privilege baseline is not known.
-- Restore the verified pre-migration backup to return to that exact state.
DO $rollback$
BEGIN
  RAISE EXCEPTION USING
    MESSAGE = 'CERP-AUDIT-002/003 grant rollback requires restoring the verified pre-migration backup',
    HINT = 'Do not REVOKE in place: the privileges may predate this corrective patch.';
END
$rollback$;
