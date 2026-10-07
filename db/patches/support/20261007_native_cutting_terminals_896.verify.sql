DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.cerp_terminals'::regclass
   AND conname='cerp_terminals_kind_check' AND convalidated
   AND pg_get_constraintdef(oid) LIKE '%CUTTING%')
 THEN RAISE EXCEPTION 'Validated CUTTING terminal kind constraint missing'; END IF;
 IF EXISTS(SELECT 1 FROM public.cerp_terminals t JOIN public.production_devices d ON d.id=t.device_id
   WHERE t.kind='CUTTING' AND d.machine_id IS NOT NULL)
 THEN RAISE EXCEPTION 'A CUTTING terminal must not be bound to a machine'; END IF;
END $$;
