\set ON_ERROR_STOP on
BEGIN READ ONLY;
SET LOCAL ROLE cerp_app;
SELECT current_database(),current_user;
SELECT id,of_id,operation_id,declaration_id,command_key FROM public.production_material_debits LIMIT 0;
SELECT debit_id,need_id,reservation_id,stock_movement_id FROM public.production_material_debit_sources LIMIT 0;
SELECT material_debit_id FROM public.production_transfer_batches LIMIT 0;
SELECT tgname,tgenabled FROM pg_trigger WHERE tgrelid IN ('public.production_material_debits'::regclass,'public.production_material_debit_sources'::regclass) AND NOT tgisinternal;
COMMIT;
