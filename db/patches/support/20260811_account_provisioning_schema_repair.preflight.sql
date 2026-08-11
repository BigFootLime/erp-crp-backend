-- Read-only preflight for the SOL-02 schema-drift repair.

SELECT
  current_database() IN ('cerp_test', 'cerp_prod') AS approved_database,
  to_regclass('public.users') IS NOT NULL AS users_present,
  to_regclass('public.erp_audit_logs') IS NOT NULL AS audit_present,
  to_regclass('public.realtime_session_epochs') IS NOT NULL AS session_epochs_present,
  to_regclass('public.realtime_authorization_epoch') IS NOT NULL AS authorization_epoch_present,
  EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') AS cerp_app_role_present,
  to_regclass('public.password_reset_tokens') IS NOT NULL AS password_reset_tokens_present,
  to_regclass('public.admin_account_invitations') IS NOT NULL AS invitations_present;
