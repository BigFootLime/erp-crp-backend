DO $$
BEGIN
  IF to_regclass('public.article_sale_price_history') IS NULL THEN
    RAISE EXCEPTION '#672 article_sale_price_history is missing';
  END IF;

  IF (SELECT COUNT(*)
      FROM information_schema.columns required
      WHERE required.table_schema = 'public'
        AND required.table_name = 'articles'
        AND required.column_name IN (
        'sale_price_reference', 'sale_price_currency', 'sale_price_source',
        'sale_price_source_entity_type', 'sale_price_source_entity_id',
        'sale_price_updated_at', 'sale_price_updated_by'
      )) <> 7 THEN
    RAISE EXCEPTION '#672 articles sale-price columns are incomplete';
  END IF;

  IF (SELECT COUNT(*) FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'commande_ligne'
        AND column_name IN (
          'sale_price_reference_at_entry', 'sale_price_reference_source',
          'sale_price_decision', 'sale_price_history_id'
        )) <> 4 THEN
    RAISE EXCEPTION '#672 commande_ligne sale-price snapshot is incomplete';
  END IF;
END $$;

SELECT
  (SELECT COUNT(*) FROM public.articles WHERE sale_price_reference IS NOT NULL) AS priced_articles,
  (SELECT COUNT(*) FROM public.article_sale_price_history) AS price_history_entries,
  (SELECT COUNT(*) FROM public.commande_ligne WHERE sale_price_reference_at_entry IS NOT NULL) AS snapshotted_order_lines;
