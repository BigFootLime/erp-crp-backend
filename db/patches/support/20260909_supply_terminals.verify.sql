SELECT current_database();
SELECT conname,convalidated,pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.cerp_terminals'::regclass AND conname IN('cerp_terminals_kind_check','cerp_terminals_warehouse_fk');
SELECT kind,count(*) FROM public.cerp_terminals GROUP BY kind;
