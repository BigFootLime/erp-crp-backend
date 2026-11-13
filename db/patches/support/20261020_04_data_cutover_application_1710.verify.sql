SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN
 ('data_cutover_application_runs','data_cutover_application_crosswalk','data_cutover_application_operations','data_cutover_application_order_groups') ORDER BY table_name;
SELECT tgname,tgenabled FROM pg_trigger WHERE tgrelid IN
 ('public.data_cutover_application_runs'::regclass,'public.data_cutover_application_crosswalk'::regclass,'public.data_cutover_application_operations'::regclass,'public.data_cutover_application_order_groups'::regclass)
 AND NOT tgisinternal ORDER BY tgname;
SELECT count(*) AS applications FROM public.data_cutover_application_runs;
