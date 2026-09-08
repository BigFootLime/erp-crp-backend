\set ON_ERROR_STOP on
BEGIN READ ONLY;
SELECT current_database(),current_user;
SELECT conname,pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.quality_control'::regclass AND conname IN('quality_control_context_chk','quality_control_context_v2_chk');
SELECT source_type,source_id,lot_id,article_id,plan_id,plan_snapshot_sha256,qty_population FROM public.quality_control LIMIT 0;
COMMIT;
