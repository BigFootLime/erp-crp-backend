-- VERIFY CA-SEC-03 — erp_audit_logs append-only.   (SUPERUSER, on cerp_test)
--
--   sudo -u postgres psql -d cerp_test -f db/privileged/20260707_erp_audit_logs_append_only.verify.sql
--
-- Expected result:
--   owner       = postgres
--   cerp_app    = INSERT,SELECT
--   [1] INSERT  -> SUCCESS (INSERT 0 1)
--   [2] UPDATE  -> ERROR: permission denied for table erp_audit_logs  (privilege layer)
--   [3] DELETE  -> ERROR: permission denied for table erp_audit_logs  (privilege layer)
--   [4] UPDATE  -> ERROR: erp_audit_logs is append-only ...           (trigger backstop, owner)
--   leftover    = 0

\pset pager off
\set ON_ERROR_STOP off

\echo '### owner (expect: postgres)'
SELECT tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename = 'erp_audit_logs';

\echo '### cerp_app table grants (expect: INSERT,SELECT)'
SELECT COALESCE(string_agg(privilege_type, ',' ORDER BY privilege_type), '(none)') AS cerp_app_privs
FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND table_name = 'erp_audit_logs' AND grantee = 'cerp_app';

\echo '### existing append-only triggers (expect 3)'
SELECT tgname FROM pg_trigger
WHERE tgrelid = 'public.erp_audit_logs'::regclass AND NOT tgisinternal
ORDER BY tgname;

\echo '### [1] app role INSERT — EXPECT SUCCESS'
SET ROLE cerp_app;
INSERT INTO public.erp_audit_logs (user_id, event_type, action)
VALUES (0, 'ACTION', 'ca_sec_03_verify');

\echo '### [2] app role UPDATE — EXPECT: permission denied'
UPDATE public.erp_audit_logs SET action = 'tampered' WHERE action = 'ca_sec_03_verify';

\echo '### [3] app role DELETE — EXPECT: permission denied'
DELETE FROM public.erp_audit_logs WHERE action = 'ca_sec_03_verify';
RESET ROLE;

\echo '### [4] trigger backstop: privileged UPDATE on the real row — EXPECT append-only exception'
UPDATE public.erp_audit_logs SET action = 'tampered' WHERE action = 'ca_sec_03_verify';

\echo '### [5] controlled maintenance cleanup (superuser + replica) — removes the marker row'
SET session_replication_role = 'replica';
DELETE FROM public.erp_audit_logs WHERE action = 'ca_sec_03_verify';
SET session_replication_role = 'origin';

\echo '### leftover marker rows (expect 0)'
SELECT count(*) AS leftover FROM public.erp_audit_logs WHERE action = 'ca_sec_03_verify';
