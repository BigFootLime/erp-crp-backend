-- The schema is dormant: migration alone must never activate an external portal.
SELECT to_regclass('public.fournisseurs') IS NOT NULL AS suppliers_available,
       to_regclass('public.commande_fournisseur') IS NOT NULL AS supplier_orders_available,
       to_regclass('public.commande_fournisseur_ligne') IS NOT NULL AS supplier_order_lines_available;
SELECT COALESCE((SELECT enabled FROM public.supplier_portal_configuration WHERE id=true),false) AS portal_already_enabled;
