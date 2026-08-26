-- Read-only preflight for 20260826_zzz_internal_order_auto_destination_883.sql.
BEGIN TRANSACTION READ ONLY;

SELECT
  c.oid IS NOT NULL AS has_commande_client,
  pg_get_constraintdef(k.oid, true) AS current_constraint_definition,
  count(cc.*) FILTER (
    WHERE cc.order_type = 'INTERNE'
      AND cc.dest_stock_magasin_id IS NULL
  )::bigint AS internal_orders_without_preselected_warehouse
FROM (SELECT to_regclass('public.commande_client') AS oid) c
LEFT JOIN pg_constraint k
  ON k.conrelid = c.oid
 AND k.conname = 'commande_client_internal_stock_dest_check'
LEFT JOIN public.commande_client cc ON true
GROUP BY c.oid, k.oid;

ROLLBACK;
