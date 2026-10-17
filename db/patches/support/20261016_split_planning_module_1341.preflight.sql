SELECT current_database() AS database, current_user AS operator,
       to_regclass('public.app_modules') IS NOT NULL AS module_catalog_ready,
       to_regclass('public.app_module_user_access') IS NOT NULL AS account_module_access_ready,
       to_regclass('public.realtime_authorization_epoch') IS NOT NULL AS epoch_ready;

SELECT module_key, api_prefixes, nav_page_keys
FROM public.app_modules
WHERE module_key IN ('production', 'planning')
ORDER BY module_key;

SELECT count(*) AS planning_grants_seeded
FROM public.app_module_user_access a
JOIN public.app_modules m ON m.module_key = a.module_key
WHERE m.module_key = 'planning';
