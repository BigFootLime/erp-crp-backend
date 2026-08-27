DO $$
BEGIN
  IF to_regclass('public.article_sale_price_history') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.article_sale_price_history) THEN
    RAISE EXCEPTION '#672 rollback refused: article sale-price history is not empty';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.commande_ligne
    WHERE sale_price_reference_at_entry IS NOT NULL OR sale_price_history_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION '#672 rollback refused: customer-order price snapshots exist';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.articles
    WHERE sale_price_reference IS NOT NULL OR sale_price_source IS NOT NULL
  ) THEN
    RAISE EXCEPTION '#672 rollback refused: article sale-price references exist';
  END IF;
END $$;

ALTER TABLE public.commande_ligne
  DROP CONSTRAINT IF EXISTS commande_ligne_sale_price_history_fkey,
  DROP CONSTRAINT IF EXISTS commande_ligne_sale_price_decision_chk,
  DROP CONSTRAINT IF EXISTS commande_ligne_sale_price_source_chk,
  DROP CONSTRAINT IF EXISTS commande_ligne_sale_price_reference_chk,
  DROP COLUMN IF EXISTS sale_price_history_id,
  DROP COLUMN IF EXISTS sale_price_decision,
  DROP COLUMN IF EXISTS sale_price_reference_source,
  DROP COLUMN IF EXISTS sale_price_reference_at_entry;

DROP TABLE IF EXISTS public.article_sale_price_history;

ALTER TABLE public.articles
  DROP CONSTRAINT IF EXISTS articles_sale_price_updated_by_fkey,
  DROP CONSTRAINT IF EXISTS articles_sale_price_source_chk,
  DROP CONSTRAINT IF EXISTS articles_sale_price_currency_chk,
  DROP CONSTRAINT IF EXISTS articles_sale_price_reference_chk,
  DROP COLUMN IF EXISTS sale_price_updated_by,
  DROP COLUMN IF EXISTS sale_price_updated_at,
  DROP COLUMN IF EXISTS sale_price_source_entity_id,
  DROP COLUMN IF EXISTS sale_price_source_entity_type,
  DROP COLUMN IF EXISTS sale_price_source,
  DROP COLUMN IF EXISTS sale_price_currency,
  DROP COLUMN IF EXISTS sale_price_reference;
