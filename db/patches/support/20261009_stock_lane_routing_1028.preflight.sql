BEGIN READ ONLY;
SELECT location_id,lane,row_version FROM public.stock_lane_locations LIMIT 0;
SELECT receipt_id,quantity,distribution FROM public.production_receipt_lane_assignments LIMIT 0;
SELECT id,commande_ligne_affaire_allocation_id,of_component_requirement_id,qty_reserved,qty_consumed,qty_prepared
  FROM public.stock_reservations LIMIT 0;
SELECT 'public.fn_protect_stock_immutable_evidence'::regproc;
SELECT has_table_privilege('cerp_app','public.stock_movements','INSERT') AS ledger_write;
ROLLBACK;
