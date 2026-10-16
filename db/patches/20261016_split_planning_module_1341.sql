-- #1341 — Planning becomes an independently selected module.
-- No user decision is copied: all non-superadmin accounts remain closed until
-- an owner explicitly grants the new catalogue entry.

UPDATE public.app_modules
SET
  label = 'Production',
  description = 'Ordres de fabrication, pointages et poste opérateur.',
  api_prefixes = ARRAY['/production', '/programmations'],
  nav_page_keys = ARRAY[
    'production-dashboard',
    'machines-postes',
    'production-readiness',
    'production-execution',
    'atelier-station',
    'production-pointages',
    'ordres-fabrication'
  ],
  updated_at = now()
WHERE module_key = 'production';

INSERT INTO public.app_modules (
  module_key, label, description, category, api_prefixes, nav_page_keys,
  is_protected, sort_order
) VALUES
  (
    'planning',
    'Planning',
    'Ordonnancement des OF et calendriers de capacité.',
    'Production',
    ARRAY['/planning'],
    ARRAY['production-planning', 'production-calendars'],
    false,
    111
  )
ON CONFLICT (module_key) DO UPDATE
SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  category = EXCLUDED.category,
  api_prefixes = EXCLUDED.api_prefixes,
  nav_page_keys = EXCLUDED.nav_page_keys,
  is_protected = EXCLUDED.is_protected,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();

DO $catalogue_guard$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.app_modules
    WHERE module_key = 'production'
      AND api_prefixes = ARRAY['/production', '/programmations']
      AND NOT ('production-planning' = ANY(nav_page_keys))
      AND NOT ('production-calendars' = ANY(nav_page_keys))
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.app_modules
    WHERE module_key = 'planning'
      AND api_prefixes = ARRAY['/planning']
      AND nav_page_keys = ARRAY['production-planning', 'production-calendars']
  ) THEN
    RAISE EXCEPTION 'AUDIT-1341 module catalogue split failed';
  END IF;
END
$catalogue_guard$;

-- Existing process caches resolve profiles by this epoch.  Bump it without
-- manufacturing per-account grants: the new modules are closed by default.
UPDATE public.realtime_authorization_epoch
SET epoch = epoch + 1, updated_at = clock_timestamp()
WHERE singleton = true;
