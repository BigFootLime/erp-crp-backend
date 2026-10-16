SELECT current_database() AS database, current_user AS operator,
       to_regclass('public.users') IS NOT NULL AS users_ready,
       to_regclass('public.app_modules') IS NOT NULL AS module_catalog_ready,
       to_regclass('public.erp_audit_logs') IS NOT NULL AS audit_ready,
       to_regclass('public.realtime_authorization_epoch') IS NOT NULL AS epoch_ready;
-- Resolve and review nominated account identities privately; no grants are seeded by this patch.
