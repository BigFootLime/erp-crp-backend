SELECT current_database();
SELECT to_regclass('public.cerp_terminals'),to_regclass('public.cerp_terminal_pins'),to_regclass('public.operator_device_sessions');
SELECT t.id,t.warehouse_id FROM public.cerp_terminals t LEFT JOIN public.magasins m ON m.id=t.warehouse_id WHERE t.warehouse_id IS NOT NULL AND m.id IS NULL;
SELECT conname,pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.cerp_terminals'::regclass;
