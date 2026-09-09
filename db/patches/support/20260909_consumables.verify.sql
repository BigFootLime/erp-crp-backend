BEGIN;
SET LOCAL ROLE cerp_app;
SELECT current_database(), current_user;
SELECT code,label,piece_technique_required FROM public.article_category_referential WHERE code='consommable';
SELECT internal_reference,consumption_mode,purchase_pack_qty,receipt_quality_required FROM public.articles LIMIT 0;
SELECT need_kind,consumption_mode,stock_managed,receipt_quality_required FROM public.of_material_needs LIMIT 0;
SELECT is_consumable_pack FROM public.lots LIMIT 0;
ROLLBACK;
