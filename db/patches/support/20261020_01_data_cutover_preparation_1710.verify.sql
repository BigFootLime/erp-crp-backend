SELECT table_name FROM information_schema.tables
WHERE table_schema='public' AND table_name IN
 ('data_cutover_batches','data_cutover_rows','data_cutover_commands','data_cutover_events','data_cutover_contributors')
ORDER BY table_name;
SELECT tgname,tgenabled FROM pg_trigger
WHERE tgrelid='public.data_cutover_rows'::regclass AND NOT tgisinternal;
SELECT indexname FROM pg_indexes
WHERE schemaname='public' AND tablename IN
 ('data_cutover_rows','data_cutover_commands','data_cutover_contributors','data_cutover_events')
ORDER BY indexname;
SELECT status,count(*) AS preparation_batches FROM public.data_cutover_batches GROUP BY status;
