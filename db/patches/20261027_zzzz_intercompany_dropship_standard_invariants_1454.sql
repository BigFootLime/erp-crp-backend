-- #1454 follow-up: retain the former articles_fabrique FK protections after
-- allowing guarded PURCHASED lines for supplier-direct EC orders.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION public.guard_articles_fabrique_standard_references_1454()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.commande_ligne line
    JOIN public.commande_client command ON command.id=line.commande_id
    WHERE line.article_id=OLD.article_id AND command.fulfilment_mode='STANDARD'
  ) THEN
    RAISE EXCEPTION USING ERRCODE='23503',
      MESSAGE='articles_fabrique cannot be removed or reassigned while referenced by a STANDARD commande line';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS articles_fabrique_standard_references_1454 ON public.articles_fabrique;
CREATE TRIGGER articles_fabrique_standard_references_1454
BEFORE DELETE OR UPDATE OF article_id ON public.articles_fabrique
FOR EACH ROW EXECUTE FUNCTION public.guard_articles_fabrique_standard_references_1454();

CREATE OR REPLACE FUNCTION public.guard_commande_client_fulfilment_mode_1454()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.fulfilment_mode IS NOT DISTINCT FROM NEW.fulfilment_mode THEN
    RETURN NEW;
  END IF;
  IF NEW.fulfilment_mode='STANDARD' AND EXISTS (
    SELECT 1 FROM public.commande_ligne line
    LEFT JOIN public.articles_fabrique fabricated ON fabricated.article_id=line.article_id
    WHERE line.commande_id=NEW.id AND line.article_id IS NOT NULL AND fabricated.article_id IS NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE='23514',
      MESSAGE='A dropship order with purchased lines cannot be changed to STANDARD';
  END IF;
  IF NEW.fulfilment_mode='SUPPLIER_DROPSHIP' AND EXISTS (
    SELECT 1
    FROM public.commande_ligne line
    LEFT JOIN public.intercompany_commercial_catalogue mapping ON mapping.id=line.intercompany_catalogue_mapping_id
    LEFT JOIN public.intercompany_supplier_relations relation ON relation.id=mapping.relation_id
    LEFT JOIN public.articles article ON article.id=line.article_id
    WHERE line.commande_id=NEW.id AND line.article_id IS NOT NULL AND NOT (
      mapping.id IS NOT NULL AND mapping.local_role='BUYER' AND mapping.active
      AND mapping.local_article_id=line.article_id
      AND relation.local_role='BUYER' AND relation.status='ACTIVE'
      AND article.article_type='PURCHASED' AND article.article_category='achat' AND article.stock_managed=false
    )
  ) THEN
    RAISE EXCEPTION USING ERRCODE='23514',
      MESSAGE='SUPPLIER_DROPSHIP requires every non-historical line to retain an active buyer mapping to a purchased non-stock article';
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
