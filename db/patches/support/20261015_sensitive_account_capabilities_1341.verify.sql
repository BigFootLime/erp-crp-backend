SELECT to_regclass('public.app_user_sensitive_capabilities') IS NOT NULL AS registry_present;
SELECT conname, convalidated FROM pg_constraint
 WHERE conrelid = to_regclass('public.app_user_sensitive_capabilities') ORDER BY conname;
SELECT count(*) AS grants_for_inactive_accounts
 FROM public.app_user_sensitive_capabilities c JOIN public.users u ON u.id=c.user_id
 WHERE c.granted AND u.status IS DISTINCT FROM 'Active';
