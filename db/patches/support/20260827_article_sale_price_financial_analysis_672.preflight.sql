SELECT current_database() AS database_name, current_user AS database_user;

SELECT relation_name, to_regclass('public.' || relation_name) IS NOT NULL AS present
FROM unnest(ARRAY[
  'articles',
  'commande_ligne',
  'devis',
  'devis_ligne',
  'ordres_fabrication',
  'of_operations',
  'of_receipts',
  'pieces_techniques_achats',
  'facture_source_allocations',
  'bon_livraison_ligne'
]) AS relation_name;

SELECT COUNT(*) AS negative_customer_order_prices
FROM public.commande_ligne
WHERE prix_unitaire_ht < 0;
