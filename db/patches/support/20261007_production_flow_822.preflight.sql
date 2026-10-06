\set ON_ERROR_STOP on
SELECT id,operation_id,declaration_id FROM public.production_material_debits LIMIT 0;
SELECT reservation_id,actual_qty,planned_qty FROM public.production_material_debit_sources LIMIT 0;
SELECT id,status FROM public.of_operations LIMIT 0;
SELECT id,qty_scrap FROM public.production_quantity_declarations LIMIT 0;
SELECT 'public.prevent_material_debit_rewrite()'::regprocedure;
