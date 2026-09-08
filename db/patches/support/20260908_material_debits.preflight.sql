\set ON_ERROR_STOP on
BEGIN READ ONLY;
SELECT current_database(),current_user;
SELECT 'public.of_material_commands'::regclass,'public.of_material_needs'::regclass,'public.production_quantity_declarations'::regclass,'public.production_transfer_batches'::regclass,'public.of_material_consumptions'::regclass;
SELECT qty_reserved,qty_consumed,qty_prepared,material_need_id,stock_batch_id FROM public.stock_reservations LIMIT 0;
SELECT operation_id,successor_operation_id,quantity,released_quantity FROM public.production_transfer_batches LIMIT 0;
COMMIT;
