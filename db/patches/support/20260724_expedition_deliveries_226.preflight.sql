-- Read-only preflight for issue #226.
SELECT prerequisite, ok
FROM (
  VALUES
    ('bon_livraison', to_regclass('public.bon_livraison') IS NOT NULL),
    ('bon_livraison_ligne', to_regclass('public.bon_livraison_ligne') IS NOT NULL),
    ('bon_livraison_ligne_allocations', to_regclass('public.bon_livraison_ligne_allocations') IS NOT NULL),
    ('bon_livraison_documents', to_regclass('public.bon_livraison_documents') IS NOT NULL),
    ('bon_livraison_event_log', to_regclass('public.bon_livraison_event_log') IS NOT NULL),
    ('commande_ligne', to_regclass('public.commande_ligne') IS NOT NULL),
    ('documents_clients', to_regclass('public.documents_clients') IS NOT NULL),
    ('emplacements', to_regclass('public.emplacements') IS NOT NULL),
    ('locations', to_regclass('public.locations') IS NOT NULL),
    ('magasins', to_regclass('public.magasins') IS NOT NULL),
    ('stock_levels', to_regclass('public.stock_levels') IS NOT NULL),
    ('stock_batches', to_regclass('public.stock_batches') IS NOT NULL),
    ('stock_reservations', to_regclass('public.stock_reservations') IS NOT NULL),
    ('stock_command_receipts', to_regclass('public.stock_command_receipts') IS NOT NULL),
    ('stock_movement_event_log', to_regclass('public.stock_movement_event_log') IS NOT NULL),
    ('users', to_regclass('public.users') IS NOT NULL),
    ('gen_random_uuid', to_regprocedure('gen_random_uuid()') IS NOT NULL)
) AS checks(prerequisite, ok)
ORDER BY prerequisite;

SELECT
  table_name,
  column_name,
  data_type,
  udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND (
    (table_name = 'bon_livraison' AND column_name = 'id')
    OR (table_name = 'bon_livraison_ligne' AND column_name IN ('id', 'commande_ligne_id'))
    OR (table_name = 'bon_livraison_ligne_allocations' AND column_name IN ('article_id', 'lot_id'))
    OR (table_name = 'magasins' AND column_name = 'id')
    OR (table_name = 'emplacements' AND column_name = 'id')
    OR (table_name = 'locations' AND column_name = 'id')
    OR (table_name = 'stock_levels' AND column_name = 'id')
    OR (table_name = 'stock_batches' AND column_name = 'id')
    OR (table_name = 'stock_reservations' AND column_name = 'id')
  )
ORDER BY table_name, column_name;

SELECT
  count(*) FILTER (WHERE statut = 'READY') AS ready_count,
  count(*) FILTER (WHERE statut IN ('SHIPPED', 'DELIVERED')) AS immutable_business_count
FROM public.bon_livraison;
