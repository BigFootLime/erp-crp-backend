SELECT current_database() AS database_name,
       to_regclass('public.data_cutover_opening_states') IS NOT NULL AS opening_states_present,
       to_regclass('public.ordres_fabrication') IS NOT NULL AS ofs_present,
       to_regclass('public.of_operations') IS NOT NULL AS operations_present,
       to_regclass('public.commande_client') IS NOT NULL AS customer_orders_present,
       to_regclass('public.commande_ligne') IS NOT NULL AS customer_order_lines_present,
       to_regclass('public.commande_ligne_affaire_allocation') IS NOT NULL AS delivery_allocations_present,
       to_regclass('public.affaire') IS NOT NULL AS delivery_affairs_present,
       to_regclass('public.piece_technique_versions') IS NOT NULL AS versions_present;
