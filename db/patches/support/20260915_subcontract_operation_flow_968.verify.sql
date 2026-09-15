SELECT to_regprocedure('public.subcontract_receipt_transferred_968(uuid)') IS NOT NULL AS receipt_balance,
       to_regclass('public.subcontract_supplier_calendars') IS NOT NULL AS supplier_calendars;
SELECT tgrelid::regclass,tgname,tgenabled FROM pg_trigger
WHERE NOT tgisinternal AND tgname IN('subcontract_flow_968','subcontract_stock_968') ORDER BY 1,2;
SELECT r.id FROM public.reception_subcontract_origins r JOIN public.production_transfer_batches b ON b.subcontract_origin_id=r.id
GROUP BY r.id HAVING sum(b.released_quantity)>r.quantity;
SELECT l.id FROM public.reception_fournisseur_lignes l WHERE public.subcontract_receipt_transferred_968(l.id)+COALESCE((
  SELECT sum(s.qty) FROM public.reception_fournisseur_stock_receipts s JOIN public.stock_movements m ON m.id=s.stock_movement_id
  WHERE s.reception_line_id=l.id AND m.status='POSTED'),0)>l.qty_received;
