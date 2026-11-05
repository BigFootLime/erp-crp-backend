DO $$ BEGIN
 IF position('DECOUPE' in pg_get_functiondef('public.fn_guard_version_purchase_712()'::regprocedure))=0 THEN RAISE EXCEPTION 'Material operation scope missing'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.pieces_techniques_operations'::regclass AND tgname='sync_purchase_operation_1833' AND tgenabled='O') THEN RAISE EXCEPTION 'Operation link protection missing'; END IF;
END $$;
