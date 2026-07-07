-- ROLLBACK for 20260707_erp_audit_logs_append_only.sql   (SUPERUSER ONLY)
--
-- Restores the pre-CA-SEC-03 state: cerp_app owns erp_audit_logs (+ its sequence)
-- with full privileges, and the append-only trigger/function are removed.
--
--   sudo -u postgres psql -d <db> -f db/privileged/20260707_erp_audit_logs_append_only.rollback.sql
--
-- Non-destructive: no audit row is modified or deleted.

BEGIN;

DROP TRIGGER IF EXISTS trg_erp_audit_logs_no_update ON public.erp_audit_logs;
DROP TRIGGER IF EXISTS trg_erp_audit_logs_no_delete ON public.erp_audit_logs;
DROP TRIGGER IF EXISTS trg_erp_audit_logs_no_truncate ON public.erp_audit_logs;
DROP FUNCTION IF EXISTS public.erp_audit_logs_prevent_mutation();

-- Restore ownership + privileges to the app role (prior state).
DO $rb$
DECLARE
  v_seq text;
BEGIN
  IF to_regclass('public.erp_audit_logs') IS NULL THEN
    RAISE NOTICE 'rollback: public.erp_audit_logs missing — nothing to do';
    RETURN;
  END IF;

  EXECUTE 'ALTER TABLE public.erp_audit_logs OWNER TO cerp_app';

  v_seq := pg_get_serial_sequence('public.erp_audit_logs', 'id');
  IF v_seq IS NOT NULL THEN
    EXECUTE format('ALTER SEQUENCE %s OWNER TO cerp_app', v_seq);
  END IF;

  EXECUTE 'GRANT ALL ON public.erp_audit_logs TO cerp_app';
  IF v_seq IS NOT NULL THEN
    EXECUTE format('GRANT ALL ON SEQUENCE %s TO cerp_app', v_seq);
  END IF;
END
$rb$;

COMMIT;
