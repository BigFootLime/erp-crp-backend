-- #1454: preserve the FK-era KEY SHARE concurrency protection for STANDARD lines.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION public.guard_commande_ligne_article_domain_1454()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE order_mode text;
BEGIN
  IF NEW.article_id IS NULL THEN RETURN NEW; END IF;
  SELECT fulfilment_mode INTO order_mode FROM public.commande_client WHERE id=NEW.commande_id;
  IF order_mode='SUPPLIER_DROPSHIP' THEN
    IF NOT EXISTS (SELECT 1 FROM public.intercompany_commercial_catalogue mapping JOIN public.intercompany_supplier_relations relation ON relation.id=mapping.relation_id JOIN public.articles article ON article.id=NEW.article_id WHERE mapping.id=NEW.intercompany_catalogue_mapping_id AND mapping.local_role='BUYER' AND mapping.active AND mapping.local_article_id=NEW.article_id AND relation.local_role='BUYER' AND relation.status='ACTIVE' AND article.article_type='PURCHASED' AND article.article_category='achat' AND article.stock_managed=false) THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='SUPPLIER_DROPSHIP commande lines require an active buyer commercial mapping to a purchased non-stock article';
    END IF;
    RETURN NEW;
  END IF;
  PERFORM 1 FROM public.articles_fabrique WHERE article_id=NEW.article_id FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='STANDARD commande lines require an articles_fabrique article'; END IF;
  IF NEW.intercompany_catalogue_mapping_id IS NOT NULL THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='STANDARD commande lines cannot retain an intercompany commercial mapping'; END IF;
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION public.guard_articles_fabrique_standard_references_1454()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.article_id IS NOT DISTINCT FROM OLD.article_id THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM public.commande_ligne line JOIN public.commande_client command ON command.id=line.commande_id WHERE line.article_id=OLD.article_id AND command.fulfilment_mode='STANDARD') THEN
    RAISE EXCEPTION USING ERRCODE='23503', MESSAGE='articles_fabrique cannot be removed or reassigned while referenced by a STANDARD commande line';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END; $$;

CREATE OR REPLACE FUNCTION public.guard_commande_client_fulfilment_mode_1454()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.fulfilment_mode IS NOT DISTINCT FROM NEW.fulfilment_mode THEN RETURN NEW; END IF;
  IF NEW.fulfilment_mode='STANDARD' THEN
    PERFORM 1 FROM public.articles_fabrique fabricated JOIN public.commande_ligne line ON line.article_id=fabricated.article_id WHERE line.commande_id=NEW.id AND line.article_id IS NOT NULL FOR KEY SHARE OF fabricated;
    IF EXISTS (SELECT 1 FROM public.commande_ligne line LEFT JOIN public.articles_fabrique fabricated ON fabricated.article_id=line.article_id WHERE line.commande_id=NEW.id AND line.article_id IS NOT NULL AND fabricated.article_id IS NULL) THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='A dropship order with purchased lines cannot be changed to STANDARD'; END IF;
  END IF;
  IF NEW.fulfilment_mode='SUPPLIER_DROPSHIP' AND EXISTS (SELECT 1 FROM public.commande_ligne line LEFT JOIN public.intercompany_commercial_catalogue mapping ON mapping.id=line.intercompany_catalogue_mapping_id LEFT JOIN public.intercompany_supplier_relations relation ON relation.id=mapping.relation_id LEFT JOIN public.articles article ON article.id=line.article_id WHERE line.commande_id=NEW.id AND line.article_id IS NOT NULL AND NOT (mapping.id IS NOT NULL AND mapping.local_role='BUYER' AND mapping.active AND mapping.local_article_id=line.article_id AND relation.local_role='BUYER' AND relation.status='ACTIVE' AND article.article_type='PURCHASED' AND article.article_category='achat' AND article.stock_managed=false)) THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='SUPPLIER_DROPSHIP requires every non-historical line to retain an active buyer mapping to a purchased non-stock article'; END IF;
  RETURN NEW;
END; $$;
COMMIT;
