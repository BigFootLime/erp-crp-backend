-- 20260707_erp_audit_logs_append_only.sql   (PRIVILEGED — SUPERUSER ONLY)
--
-- ISO/IEC 27001:2022 A.8.15 (Logging) — corrective action CA-SEC-03.
-- Make public.erp_audit_logs APPEND-ONLY for the application role (cerp_app).
--
-- WHY THIS IS NOT A NORMAL db/patches PATCH
--   The `db:patches` runner connects as the app role (cerp_app, via DATABASE_URL).
--   cerp_app currently OWNS erp_audit_logs, and a table owner bypasses GRANT/REVOKE
--   and can even `ALTER TABLE ... DISABLE TRIGGER`. Real immutability therefore
--   requires moving ownership OFF the app role, which only a SUPERUSER can do.
--   This file lives in db/privileged/ and MUST be applied by a DBA/superuser:
--       sudo -u postgres psql -d cerp_test -f db/privileged/20260707_erp_audit_logs_append_only.sql
--       sudo -u postgres psql -d cerp_prod -f db/privileged/20260707_erp_audit_logs_append_only.sql
--   It is NOT picked up by `npm run db:patches:up` (which only reads db/patches/).
--
-- WHAT IT DOES
--   1. Reassigns the table + its id sequence to `postgres` (owner off the app role).
--   2. Restricts cerp_app to INSERT + SELECT (+ sequence USAGE) — no UPDATE/DELETE/TRUNCATE.
--   3. Adds an append-only trigger (blocks UPDATE/DELETE/TRUNCATE for everyone, incl. the
--      owner) as a hard backstop.
--
-- CONTROLLED MAINTENANCE (DBA / superuser only)
--   Retention / anonymisation (CA-RGPD-02) is performed by a superuser by temporarily
--   bypassing the append-only triggers:
--       SET session_replication_role = 'replica';
--       DELETE FROM public.erp_audit_logs WHERE created_at < now() - interval '<retention>';
--       SET session_replication_role = 'origin';
--   Only a superuser may set session_replication_role, so cerp_app cannot use this path.
--
-- SAFETY
--   Idempotent (safe to re-run). Non-destructive: no row is modified or deleted.
--   Rollback: db/privileged/20260707_erp_audit_logs_append_only.rollback.sql
--   Verify:   db/privileged/20260707_erp_audit_logs_append_only.verify.sql
--
-- Target: PostgreSQL 17. Run as SUPERUSER (postgres).

BEGIN;

-- Guard: refuse to run as a non-superuser (e.g. the app role) — would fail half-way.
DO $guard$
BEGIN
  IF NOT COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false) THEN
    RAISE EXCEPTION
      'CA-SEC-03: must be applied by a superuser; current_user=% is not a superuser', current_user;
  END IF;
END
$guard$;

DO $mig$
DECLARE
  v_seq text;
BEGIN
  IF to_regclass('public.erp_audit_logs') IS NULL THEN
    RAISE NOTICE 'CA-SEC-03: public.erp_audit_logs is missing — nothing to do';
    RETURN;
  END IF;

  -- 1) Ownership OFF the app role (so REVOKE/triggers cannot be bypassed by the owner).
  EXECUTE 'ALTER TABLE public.erp_audit_logs OWNER TO postgres';

  v_seq := pg_get_serial_sequence('public.erp_audit_logs', 'id');
  IF v_seq IS NOT NULL THEN
    EXECUTE format('ALTER SEQUENCE %s OWNER TO postgres', v_seq);
  END IF;

  -- 2) Least-privilege for the app role: INSERT + SELECT only.
  EXECUTE 'REVOKE ALL ON public.erp_audit_logs FROM cerp_app';
  EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON public.erp_audit_logs FROM PUBLIC';
  EXECUTE 'GRANT SELECT, INSERT ON public.erp_audit_logs TO cerp_app';

  -- 2b) The app still needs the id sequence to INSERT (nextval on the id default).
  IF v_seq IS NOT NULL THEN
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %s TO cerp_app', v_seq);
  END IF;
END
$mig$;

-- 3) Append-only backstop. Fires for EVERY role (including the owner). A superuser can
--    bypass it for controlled maintenance via `SET session_replication_role = 'replica'`.
CREATE OR REPLACE FUNCTION public.erp_audit_logs_prevent_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION
    'erp_audit_logs is append-only: % is not permitted (ISO/IEC 27001 A.8.15 / CA-SEC-03)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
  RETURN NULL;
END
$fn$;

DROP TRIGGER IF EXISTS trg_erp_audit_logs_no_update ON public.erp_audit_logs;
CREATE TRIGGER trg_erp_audit_logs_no_update
  BEFORE UPDATE ON public.erp_audit_logs
  FOR EACH ROW EXECUTE FUNCTION public.erp_audit_logs_prevent_mutation();

DROP TRIGGER IF EXISTS trg_erp_audit_logs_no_delete ON public.erp_audit_logs;
CREATE TRIGGER trg_erp_audit_logs_no_delete
  BEFORE DELETE ON public.erp_audit_logs
  FOR EACH ROW EXECUTE FUNCTION public.erp_audit_logs_prevent_mutation();

DROP TRIGGER IF EXISTS trg_erp_audit_logs_no_truncate ON public.erp_audit_logs;
CREATE TRIGGER trg_erp_audit_logs_no_truncate
  BEFORE TRUNCATE ON public.erp_audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION public.erp_audit_logs_prevent_mutation();

COMMIT;
