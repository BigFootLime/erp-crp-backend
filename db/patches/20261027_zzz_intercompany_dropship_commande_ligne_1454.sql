-- #1454: supplier-direct EC lines use purchased, non-stock local articles.
-- Keep the industrial fabricated-article invariant for every STANDARD order.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public.commande_ligne
  ADD COLUMN IF NOT EXISTS intercompany_catalogue_mapping_id uuid NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'commande_ligne_intercompany_catalogue_mapping_fk'
      AND conrelid = 'public.commande_ligne'::regclass
  ) THEN
    ALTER TABLE public.commande_ligne
      ADD CONSTRAINT commande_ligne_intercompany_catalogue_mapping_fk
      FOREIGN KEY (intercompany_catalogue_mapping_id)
      REFERENCES public.intercompany_commercial_catalogue(id) ON DELETE RESTRICT;
  END IF;
END $$;

ALTER TABLE public.commande_ligne
  DROP CONSTRAINT IF EXISTS commande_ligne_article_fabrique_fk;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'commande_ligne_article_fk'
      AND conrelid = 'public.commande_ligne'::regclass
  ) THEN
    ALTER TABLE public.commande_ligne
      ADD CONSTRAINT commande_ligne_article_fk
      FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.guard_commande_ligne_article_domain_1454()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  order_mode text;
BEGIN
  -- Historical lines may legitimately remain without an article reference.
  IF NEW.article_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT fulfilment_mode INTO order_mode FROM public.commande_client WHERE id=NEW.commande_id;
  IF order_mode = 'SUPPLIER_DROPSHIP' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.intercompany_commercial_catalogue mapping
      JOIN public.intercompany_supplier_relations relation ON relation.id=mapping.relation_id
      JOIN public.articles article ON article.id=NEW.article_id
      WHERE mapping.id=NEW.intercompany_catalogue_mapping_id
        AND mapping.local_role='BUYER' AND mapping.active
        AND mapping.local_article_id=NEW.article_id
        AND relation.local_role='BUYER' AND relation.status='ACTIVE'
        AND article.article_type='PURCHASED' AND article.article_category='achat'
        AND article.stock_managed=false
    ) THEN
      RAISE EXCEPTION USING ERRCODE='23514',
        MESSAGE='SUPPLIER_DROPSHIP commande lines require an active buyer commercial mapping to a purchased non-stock article';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.articles_fabrique WHERE article_id=NEW.article_id) THEN
    RAISE EXCEPTION USING ERRCODE='23514',
      MESSAGE='STANDARD commande lines require an articles_fabrique article';
  END IF;
  IF NEW.intercompany_catalogue_mapping_id IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE='23514',
      MESSAGE='STANDARD commande lines cannot retain an intercompany commercial mapping';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS commande_ligne_article_domain_1454 ON public.commande_ligne;
CREATE TRIGGER commande_ligne_article_domain_1454
BEFORE INSERT OR UPDATE OF commande_id,article_id,intercompany_catalogue_mapping_id
ON public.commande_ligne FOR EACH ROW EXECUTE FUNCTION public.guard_commande_ligne_article_domain_1454();

CREATE OR REPLACE FUNCTION public.guard_commande_client_fulfilment_mode_1454()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.fulfilment_mode='STANDARD' AND OLD.fulfilment_mode IS DISTINCT FROM NEW.fulfilment_mode
    AND EXISTS (
      SELECT 1 FROM public.commande_ligne line
      LEFT JOIN public.articles_fabrique fabricated ON fabricated.article_id=line.article_id
      WHERE line.commande_id=NEW.id AND line.article_id IS NOT NULL AND fabricated.article_id IS NULL
    ) THEN
    RAISE EXCEPTION USING ERRCODE='23514',
      MESSAGE='A dropship order with purchased lines cannot be changed to STANDARD';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS commande_client_fulfilment_mode_1454 ON public.commande_client;
CREATE TRIGGER commande_client_fulfilment_mode_1454
BEFORE UPDATE OF fulfilment_mode ON public.commande_client
FOR EACH ROW EXECUTE FUNCTION public.guard_commande_client_fulfilment_mode_1454();

COMMIT;
