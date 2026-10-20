SELECT table_name FROM information_schema.tables
WHERE table_schema='public' AND table_name IN ('data_cutover_opening_states','data_cutover_opening_links')
ORDER BY table_name;
SELECT tgname,tgenabled FROM pg_trigger
WHERE tgrelid IN ('public.data_cutover_opening_states'::regclass,'public.data_cutover_opening_links'::regclass)
  AND NOT tgisinternal ORDER BY tgrelid::regclass::text,tgname;
SELECT opening_kind,domain,count(*) AS rows
FROM public.data_cutover_opening_states GROUP BY opening_kind,domain ORDER BY opening_kind,domain;
