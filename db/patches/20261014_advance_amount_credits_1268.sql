-- #1268: exact monetary credits for qualified issued advances. Existing fiscal
-- evidence and all prior Finance guards remain unchanged.
BEGIN;

CREATE OR REPLACE FUNCTION public.fn_check_advance_amount_credit_1268()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE
  invoice_id bigint;
  allocation record;
  original jsonb;
  used_net numeric;
  used_tax numeric;
  used_gross numeric;
BEGIN
  IF TG_TABLE_NAME='avoir_source_allocations' THEN
    invoice_id:=NEW.facture_id;
  ELSE
    SELECT facture_id INTO invoice_id FROM public.avoir WHERE id=NEW.avoir_id;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.avoir_source_allocations WHERE facture_id=invoice_id AND source_type='INVOICE_AMOUNT') THEN
    RETURN NULL;
  END IF;
  PERFORM public.fn_lock_delivery_prepayment_write_1268();
  FOR allocation IN
    SELECT source.*, invoice.immutable_snapshot AS invoice_snapshot,
      invoice.remise_globale, original_line.ordre, original_line.facture_id AS line_invoice_id,
      credit_line.avoir_id AS line_credit_id,credit_line.quantite AS credit_quantity,
      credit_line.prix_unitaire_ht,credit_line.remise_ligne,credit_line.total_ht,
      credit_line.tax_amount,credit_line.total_ttc,credit_line.snapshot_json,
      credit_line.taux_tva AS credit_rate,
      EXISTS(SELECT 1 FROM public.facture_source_allocations advance WHERE advance.facture_id=invoice.id
        AND advance.facture_ligne_id=original_line.id AND advance.source_type='DEPOSIT'
        AND advance.allocation_status='CONSUMED') AS qualified_source
    FROM public.avoir_source_allocations source
    JOIN public.facture invoice ON invoice.id=source.facture_id
    LEFT JOIN public.facture_ligne original_line ON original_line.id=source.facture_ligne_id
    LEFT JOIN public.avoir_ligne credit_line ON credit_line.id=source.avoir_line_id
    WHERE source.facture_id=invoice_id AND source.source_type='INVOICE_AMOUNT'
  LOOP
    original:=allocation.invoice_snapshot->'lines'->(allocation.ordre-1);
    IF allocation.invoice_snapshot->>'invoice_type_code' IS DISTINCT FROM '386'
      OR NOT allocation.qualified_source
      OR COALESCE(allocation.remise_globale,0)<>0
      OR jsonb_typeof(original) IS DISTINCT FROM 'object'
      OR (original->>'discount_percent')::numeric IS DISTINCT FROM 0
      OR allocation.line_invoice_id IS DISTINCT FROM allocation.facture_id
      OR allocation.line_credit_id IS DISTINCT FROM allocation.avoir_id
      OR allocation.source_line_id IS DISTINCT FROM allocation.facture_ligne_id::text
      OR allocation.quantity_selected<>0 OR allocation.quantity_credited<>0
      OR allocation.credit_quantity IS DISTINCT FROM 1
      OR allocation.remise_ligne IS DISTINCT FROM 0
      OR allocation.prix_unitaire_ht IS DISTINCT FROM allocation.total_ht
      OR allocation.total_ht IS NULL OR allocation.total_ht<=0 OR allocation.tax_amount IS NULL OR allocation.tax_amount<0
      OR allocation.total_ht+allocation.tax_amount IS DISTINCT FROM allocation.total_ttc
      OR allocation.amount_ttc IS DISTINCT FROM allocation.total_ttc
      OR allocation.credit_rate IS DISTINCT FROM (original->>'tax_rate_percent')::numeric
      OR allocation.snapshot_json->>'credit_basis' IS DISTINCT FROM 'AMOUNT_EX_TAX'
      OR (allocation.snapshot_json->>'source_quantity_selected')::numeric IS DISTINCT FROM 0
      OR (allocation.snapshot_json->>'advance_amount_ex_tax')::numeric IS DISTINCT FROM allocation.total_ht
      OR (allocation.snapshot_json->>'total_ex_tax')::numeric IS DISTINCT FROM allocation.total_ht
      OR (allocation.snapshot_json->>'tax_amount')::numeric IS DISTINCT FROM allocation.tax_amount
      OR (allocation.snapshot_json->>'total_incl_tax')::numeric IS DISTINCT FROM allocation.total_ttc
    THEN
      RAISE EXCEPTION 'ADVANCE-AMOUNT-1268 monetary credit requires exact qualified source and zero physical consumption' USING ERRCODE='23514';
    END IF;
    SELECT COALESCE(sum(line.total_ht),0),COALESCE(sum(COALESCE(line.tax_amount,line.total_ttc-line.total_ht)),0),COALESCE(sum(source.amount_ttc),0)
      INTO used_net,used_tax,used_gross
    FROM public.avoir_source_allocations source JOIN public.avoir_ligne line ON line.id=source.avoir_line_id
    WHERE source.facture_ligne_id=allocation.facture_ligne_id AND source.allocation_status IN('DRAFT','CONSUMED');
    IF used_net>(original->>'total_ex_tax')::numeric OR used_tax>(original->>'tax_amount')::numeric
      OR used_gross>(original->>'total_incl_tax')::numeric
      OR (original->>'total_ex_tax') IS NULL OR (original->>'tax_amount') IS NULL OR (original->>'total_incl_tax') IS NULL
    THEN
      RAISE EXCEPTION 'ADVANCE-AMOUNT-1268 cumulative draft and issued credits exceed the original line budget' USING ERRCODE='23514';
    END IF;
  END LOOP;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_check_advance_amount_credit_1268 ON public.avoir_source_allocations;
CREATE CONSTRAINT TRIGGER trg_check_advance_amount_credit_1268 AFTER INSERT OR UPDATE ON public.avoir_source_allocations
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.fn_check_advance_amount_credit_1268();
DROP TRIGGER IF EXISTS trg_check_advance_amount_credit_1268 ON public.avoir_ligne;
CREATE CONSTRAINT TRIGGER trg_check_advance_amount_credit_1268 AFTER INSERT OR UPDATE ON public.avoir_ligne
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.fn_check_advance_amount_credit_1268();

COMMIT;
