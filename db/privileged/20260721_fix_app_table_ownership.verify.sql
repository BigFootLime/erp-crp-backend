-- VERIFY for 20260721_fix_app_table_ownership.sql
--   sudo -u postgres psql -d <db> -f db/privileged/20260721_fix_app_table_ownership.verify.sql
-- Expect only "OK:" rows. Any "FAIL:" row means the ownership/grants are inconsistent.

-- 1) No application table should remain owned by postgres, except the append-only pair.
SELECT 'FAIL: app table still owned by postgres: ' || tablename AS check
FROM pg_tables
WHERE schemaname = 'public' AND tableowner = 'postgres'
  AND tablename NOT IN ('erp_audit_logs', 'hr_time_events')
UNION ALL
-- 2) The append-only tables MUST stay postgres-owned.
SELECT 'FAIL: append-only table not postgres-owned: ' || c.relname
FROM pg_class c
WHERE c.relnamespace = 'public'::regnamespace
  AND c.relname IN ('erp_audit_logs', 'hr_time_events')
  AND pg_get_userbyid(c.relowner) <> 'postgres'
UNION ALL
-- 3) cerp_app must keep SELECT+INSERT on the append-only tables, but NOT UPDATE/DELETE.
SELECT 'FAIL: cerp_app privilege drift on ' || t AS check
FROM unnest(ARRAY['erp_audit_logs', 'hr_time_events']) AS t
WHERE NOT has_table_privilege('cerp_app', 'public.' || t, 'SELECT')
   OR NOT has_table_privilege('cerp_app', 'public.' || t, 'INSERT')
   OR has_table_privilege('cerp_app', 'public.' || t, 'UPDATE')
   OR has_table_privilege('cerp_app', 'public.' || t, 'DELETE')
UNION ALL
-- 4) Spot-check the table that triggered the incident is now readable by cerp_app.
SELECT CASE
         WHEN has_table_privilege('cerp_app', 'public.fournisseur_domaines', 'SELECT')
         THEN 'OK: cerp_app can read fournisseur_domaines'
         ELSE 'FAIL: cerp_app cannot read fournisseur_domaines'
       END
WHERE to_regclass('public.fournisseur_domaines') IS NOT NULL
UNION ALL
SELECT 'OK: ownership/grants consistent'
WHERE NOT EXISTS (
  SELECT 1 FROM pg_tables
  WHERE schemaname = 'public' AND tableowner = 'postgres'
    AND tablename NOT IN ('erp_audit_logs', 'hr_time_events')
)
ORDER BY 1;
