-- This catalogue change and its explicit decisions are retained on binary
-- rollback. Deleting Planning could cascade-delete authorization evidence;
-- merging it back into Production could broaden an employee's permissions.
-- Restore only the reviewed application artifact, then verify the retained
-- catalogue against the compatible resolver. Never delete or copy grants.
SELECT module_key, api_prefixes, nav_page_keys
FROM public.app_modules
WHERE module_key IN ('production', 'planning')
ORDER BY module_key;
