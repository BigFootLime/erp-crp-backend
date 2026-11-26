BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE FUNCTION public.guard_free_supplier_service_receipt() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.article_id IS DISTINCT FROM OLD.article_id
    AND (NEW.article_id IS NULL OR OLD.article_id IS NULL) THEN
    RAISE EXCEPTION 'A service receipt cannot change its article identity' USING ERRCODE = '23514';
  END IF;
  IF NEW.article_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.stock_managed OR NEW.receipt_quality_required OR NEW.receipt_tool_id IS NOT NULL
    OR NEW.stock_article_id IS NOT NULL OR NEW.lot_id IS NOT NULL OR NEW.supplier_lot_code IS NOT NULL
    OR NEW.destination_magasin_id IS NOT NULL OR NEW.destination_emplacement_id IS NOT NULL
    OR NEW.processing_policy IS DISTINCT FROM 'STANDARD'
    OR NEW.stock_conversion_coef IS DISTINCT FROM 1::numeric
    OR NOT EXISTS (
      SELECT 1 FROM public.commande_fournisseur_ligne l
      JOIN public.commande_fournisseur c ON c.id = l.commande_id
      JOIN public.receptions_fournisseurs r ON r.fournisseur_id = c.fournisseur_id
      WHERE l.id = NEW.commande_fournisseur_ligne_id AND r.id = NEW.reception_id
        AND r.origin_type = 'SUPPLIER' AND r.confirmation_state IN ('DRAFT', 'CONFIRMED')
        AND l.type = 'PRESTATION' AND l.article_id IS NULL
        AND NOT COALESCE(l.receipt_stock_managed, false)
        AND NOT COALESCE(l.receipt_quality_required, false)
        AND COALESCE(l.receipt_consumption_mode, 'UNIT') = 'UNIT'
        AND COALESCE(l.receipt_processing_policy, 'STANDARD') = 'STANDARD'
        AND l.receipt_tool_id IS NULL AND l.exigences_qualite = '[]'::jsonb
        AND NEW.unite = COALESCE(NULLIF(trim(l.unite), ''), 'prestation')
        AND NEW.stock_unit = NEW.unite
    ) THEN
    RAISE EXCEPTION 'Only a linked off-stock supplier service may be received without an article'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.guard_free_supplier_service_receipt() OWNER TO cerp_app;

ALTER TABLE public.reception_fournisseur_lignes ALTER COLUMN article_id DROP NOT NULL;
CREATE TRIGGER guard_free_supplier_service_receipt
  BEFORE INSERT OR UPDATE ON public.reception_fournisseur_lignes
  FOR EACH ROW EXECUTE FUNCTION public.guard_free_supplier_service_receipt();
COMMIT;
