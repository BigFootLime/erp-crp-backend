\if :{?cerp_test}
\else
  \echo 'Run with -v cerp_test=1 against cerp_test only.'
  \quit
\endif

SELECT current_database() AS database_name,
       to_regclass('public.stock_levels') IS NOT NULL AS has_stock_levels,
       to_regclass('public.commande_fournisseur') IS NOT NULL AS has_supplier_orders,
       to_regclass('public.fournisseur_catalogue') IS NOT NULL AS has_supplier_catalogue;
