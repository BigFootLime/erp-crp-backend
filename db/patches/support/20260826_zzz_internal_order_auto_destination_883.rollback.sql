-- Guarded rollback for 20260826_zzz_internal_order_auto_destination_883.sql.
BEGIN;

DO $$
BEGIN
  IF current_setting('cerp.confirm_internal_order_destination_rollback', true) IS DISTINCT FROM 'APPROVED' THEN
    RAISE EXCEPTION 'Set cerp.confirm_internal_order_destination_rollback=APPROVED after human validation';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.commande_client
    WHERE order_type = 'INTERNE'
      AND dest_stock_magasin_id IS NULL
  ) THEN
    RAISE EXCEPTION 'Rollback refused: internal orders depend on automatic stock destination resolution';
  END IF;
END $$;

ALTER TABLE public.commande_client
  ADD CONSTRAINT commande_client_internal_stock_dest_check
  CHECK (order_type <> 'INTERNE' OR dest_stock_magasin_id IS NOT NULL);

COMMIT;
