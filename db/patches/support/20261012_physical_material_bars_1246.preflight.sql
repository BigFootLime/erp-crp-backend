SELECT id,lot_id,stock_level_id,qty_total,qty_reserved FROM public.stock_batches LIMIT 0;
SELECT id,stock_batch_id,qty_reserved,qty_consumed,status,expires_at FROM public.stock_reservations LIMIT 0;
SELECT id,stock_batch_id,status FROM public.stock_movements LIMIT 0;
SELECT id FROM public.users LIMIT 0;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cerp_app') THEN
    RAISE EXCEPTION 'cerp_app role is required';
  END IF;
END $$;
