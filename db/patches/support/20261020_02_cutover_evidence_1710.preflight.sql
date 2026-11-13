SELECT to_regclass('public.data_cutover_rows') IS NOT NULL AS cutover_rows_present,to_regclass('public.ged_documents') IS NOT NULL AS ged_present;
