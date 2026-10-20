SELECT current_database() AS database_name,
       to_regclass('public.data_cutover_batches') IS NOT NULL AS batches_present,
       to_regclass('public.data_cutover_rows') IS NOT NULL AS rows_present,
       to_regclass('public.users') IS NOT NULL AS users_present;
SELECT table_name,column_name,data_type
FROM information_schema.columns
WHERE table_schema='public' AND (table_name,column_name) IN
  (('data_cutover_batches','id'),('data_cutover_rows','id'),('data_cutover_rows','batch_id'),('data_cutover_rows','domain'),('users','id'))
ORDER BY table_name,column_name;
