-- Read-only preflight for SOL-02 / SEC-CERP-0002. Expected: preflight_ok = true.

SELECT
  to_regclass('public.users') IS NOT NULL
  AND to_regclass('public.erp_audit_logs') IS NOT NULL
  AND to_regclass('public.realtime_session_epochs') IS NOT NULL
  AND to_regclass('public.realtime_authorization_epoch') IS NOT NULL
  AND to_regclass('public.password_reset_tokens') IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'users'
      AND column_name = 'status'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public.users
    WHERE status IS NULL
       OR status NOT IN ('Active', 'Inactive', 'Blocked', 'Suspended')
  ) AS preflight_ok;
