\set ON_ERROR_STOP on
SELECT cut_qty,discarded_qty,extended_qty,bar_closed FROM public.production_material_debit_sources LIMIT 0;
SELECT quantity_kind FROM public.production_material_debits LIMIT 0;
SELECT source_of_id,source_operation_id,complement_of_id,quantity,loss_snapshot,request_key FROM public.production_loss_complements LIMIT 0;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.production_loss_complements'::regclass AND tgname='production_loss_complements_immutable' AND tgenabled='O') THEN
   RAISE EXCEPTION 'Loss complement immutability trigger missing';
 END IF;
END $$;
