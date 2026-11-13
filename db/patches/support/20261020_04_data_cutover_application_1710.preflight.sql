SELECT current_database() AS database_name,
       to_regclass('public.data_cutover_batches') IS NOT NULL AS preparation_installed,
       to_regclass('public.users') IS NOT NULL AS users_present;
DO $$ BEGIN IF to_regclass('public.data_cutover_batches') IS NULL THEN
 RAISE EXCEPTION 'Install the cutover preparation patch first';
END IF; END $$;
