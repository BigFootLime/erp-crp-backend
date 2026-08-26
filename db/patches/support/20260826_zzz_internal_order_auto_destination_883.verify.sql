-- Read-only verification for 20260826_zzz_internal_order_auto_destination_883.sql.
BEGIN TRANSACTION READ ONLY;

DO $$
BEGIN
  IF to_regclass('public.commande_client') IS NULL THEN
    RAISE EXCEPTION 'Missing public.commande_client';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.commande_client'::regclass
      AND conname = 'commande_client_internal_stock_dest_check'
  ) THEN
    RAISE EXCEPTION 'Obsolete internal stock destination constraint is still present';
  END IF;
END $$;

SELECT
  count(*) FILTER (WHERE order_type = 'INTERNE')::bigint AS internal_order_count,
  count(*) FILTER (
    WHERE order_type = 'INTERNE'
      AND dest_stock_magasin_id IS NULL
      AND dest_stock_emplacement_id IS NULL
  )::bigint AS internal_orders_using_automatic_destination
FROM public.commande_client;

ROLLBACK;
