DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.app_modules
    WHERE module_key = 'production'
      AND api_prefixes = ARRAY['/production', '/programmations']
      AND NOT ('production-planning' = ANY(nav_page_keys))
      AND NOT ('production-calendars' = ANY(nav_page_keys))
  ) THEN
    RAISE EXCEPTION 'Planning split: production catalogue is not restricted to production and programmation';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.app_modules
    WHERE module_key = 'planning'
      AND api_prefixes = ARRAY['/planning']
      AND nav_page_keys = ARRAY['production-planning', 'production-calendars']
      AND NOT is_protected
  ) THEN
    RAISE EXCEPTION 'Planning split: planning catalogue entry is incomplete';
  END IF;


  IF NOT EXISTS (SELECT 1 FROM public.app_modules WHERE module_key = 'pieces-techniques' AND api_prefixes @> ARRAY['/pieces-families', '/methodes'])
     OR NOT EXISTS (SELECT 1 FROM public.app_modules WHERE module_key = 'commandes-fournisseurs' AND '/procurement-reliability' = ANY(api_prefixes))
     OR NOT EXISTS (SELECT 1 FROM public.app_modules WHERE module_key = 'facturation' AND '/accounting-exports' = ANY(api_prefixes)) THEN
    RAISE EXCEPTION 'Audit catalogue mappings are incomplete';
  END IF;  IF EXISTS (
    SELECT 1
    FROM public.app_module_user_access a
    JOIN public.app_modules m ON m.id = a.module_id
    WHERE m.module_key = 'planning'
  ) THEN
    RAISE EXCEPTION 'Planning split must not seed or copy account grants';
  END IF;
END $$;
