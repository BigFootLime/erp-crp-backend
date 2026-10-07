DO $$ BEGIN
 IF to_regclass('public.old_stock_document_references') IS NULL OR to_regclass('public.finished_lot_packaging') IS NULL OR to_regclass('public.finished_packaging_voids') IS NULL OR to_regclass('public.finished_packaging_print_intents') IS NULL OR to_regclass('public.v_technical_stock_compatibility_832') IS NULL THEN RAISE EXCEPTION 'History/packaging schema incomplete'; END IF;
 IF (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='pieces_techniques_operations' AND column_name IN('tp','tf_unit') AND numeric_scale=6)<>2 THEN RAISE EXCEPTION 'Operation time precision incomplete'; END IF;
 IF NOT has_table_privilege('cerp_app','public.old_stock_document_references','INSERT') OR NOT has_table_privilege('cerp_app','public.finished_lot_packaging','INSERT') THEN RAISE EXCEPTION 'History/packaging application grants missing'; END IF;
END $$;
SELECT target_version_id,stock_version_id FROM public.v_technical_stock_compatibility_832 LIMIT 0;
