BEGIN;

-- An EC invoice is backed by its signed supplier receipt line.  This is a
-- distinct source family: it must never be confused with a local stock BL.
ALTER TABLE public.facture_source_allocations
  DROP CONSTRAINT IF EXISTS facture_source_allocations_source_type_check;
ALTER TABLE public.facture_source_allocations
  ADD CONSTRAINT facture_source_allocations_source_type_check
  CHECK (source_type IN ('DELIVERY_LINE','EXTERNAL_FULFILMENT_RECEIPT_LINE','MILESTONE','DEPOSIT'));

CREATE OR REPLACE FUNCTION public.fn_validate_facturation_allocation_227()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  payment_amount numeric(18,2); allocated_amount numeric(18,2); invoice_amount numeric(18,2); invoice_allocated numeric(18,2);
  credit_amount numeric(18,2); credit_allocated numeric(18,2); delivery_qty numeric(18,3); sourced_qty numeric(18,3);
  source_client text; target_client text; receipt_message uuid; receipt_line integer;
BEGIN
  IF TG_TABLE_NAME = 'facture_source_allocations' AND NEW.source_type = 'EXTERNAL_FULFILMENT_RECEIPT_LINE' THEN
    -- `message_id:line_no` is the canonical immutable receipt-line identity.
    BEGIN
      receipt_message := split_part(NEW.source_line_id, ':', 1)::uuid;
      receipt_line := split_part(NEW.source_line_id, ':', 2)::integer;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'external fulfilment source identity is invalid' USING ERRCODE = '23514';
    END;
    SELECT receipt_line_row.quantity::numeric(18,3), command.client_id, invoice.client_id
      INTO delivery_qty, source_client, target_client
      FROM public.cerp_intercompany_external_fulfilment_receipt_lines receipt_line_row
      JOIN public.cerp_intercompany_external_fulfilment_receipts receipt ON receipt.message_id = receipt_line_row.message_id
      JOIN public.commande_ligne line ON line.id = receipt_line_row.buyer_sales_order_line_id
      JOIN public.commande_client command ON command.id = line.commande_id AND command.fulfilment_mode = 'SUPPLIER_DROPSHIP'
      JOIN public.facture invoice ON invoice.id = NEW.facture_id
      WHERE receipt_line_row.message_id = receipt_message AND receipt_line_row.line_no = receipt_line
      FOR UPDATE OF receipt_line_row, receipt, line, command, invoice;
    SELECT COALESCE(SUM(quantity_selected), 0)::numeric(18,3) INTO sourced_qty
      FROM public.facture_source_allocations
      WHERE source_type = 'EXTERNAL_FULFILMENT_RECEIPT_LINE' AND source_line_id = NEW.source_line_id
        AND allocation_status IN ('DRAFT','CONSUMED');
    IF delivery_qty IS NULL OR source_client IS DISTINCT FROM target_client OR sourced_qty + NEW.quantity_selected > delivery_qty THEN
      RAISE EXCEPTION 'external fulfilment invoice allocations have a client mismatch or exceed received quantity' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  -- Preserve the existing validator for its established source families.
  IF TG_TABLE_NAME = 'paiement_allocations' THEN
    SELECT montant::numeric(18,2) INTO payment_amount FROM public.paiement WHERE id = NEW.paiement_id FOR UPDATE;
    SELECT COALESCE(SUM(amount_ttc), 0)::numeric(18,2) INTO allocated_amount FROM public.paiement_allocations WHERE paiement_id = NEW.paiement_id;
    SELECT total_ttc::numeric(18,2) INTO invoice_amount FROM public.facture WHERE id = NEW.facture_id FOR UPDATE;
    SELECT COALESCE(SUM(amount_ttc), 0)::numeric(18,2) INTO invoice_allocated FROM public.paiement_allocations WHERE facture_id = NEW.facture_id;
    SELECT COALESCE(SUM(amount_ttc), 0)::numeric(18,2) INTO credit_allocated FROM public.avoir_source_allocations WHERE facture_id = NEW.facture_id;
    IF payment_amount IS NULL OR allocated_amount + NEW.amount_ttc > payment_amount OR invoice_amount IS NULL OR invoice_allocated + credit_allocated + NEW.amount_ttc > invoice_amount THEN RAISE EXCEPTION 'payment allocations exceed recorded amount' USING ERRCODE = '23514'; END IF;
  ELSIF TG_TABLE_NAME = 'avoir_source_allocations' THEN
    SELECT a.total_ttc::numeric(18,2), a.client_id, f.client_id INTO credit_amount, source_client, target_client FROM public.avoir a JOIN public.facture f ON f.id = NEW.facture_id WHERE a.id = NEW.avoir_id FOR UPDATE;
    SELECT COALESCE(SUM(amount_ttc), 0)::numeric(18,2) INTO credit_allocated FROM public.avoir_source_allocations WHERE avoir_id = NEW.avoir_id;
    IF source_client IS DISTINCT FROM target_client OR credit_amount IS NULL OR credit_allocated + NEW.amount_ttc > credit_amount THEN RAISE EXCEPTION 'credit allocation has a client mismatch or exceeds the credit note' USING ERRCODE = '23514'; END IF;
  ELSIF TG_TABLE_NAME = 'facture_source_allocations' AND NEW.source_type = 'DELIVERY_LINE' THEN
    SELECT bll.quantite::numeric(18,3), bl.client_id, f.client_id INTO delivery_qty, source_client, target_client FROM public.bon_livraison_ligne bll JOIN public.bon_livraison bl ON bl.id=bll.bon_livraison_id JOIN public.facture f ON f.id=NEW.facture_id WHERE bll.id::text=NEW.source_line_id FOR UPDATE OF bll,bl,f;
    SELECT COALESCE(SUM(quantity_selected),0)::numeric(18,3) INTO sourced_qty FROM public.facture_source_allocations WHERE source_type='DELIVERY_LINE' AND source_line_id=NEW.source_line_id AND allocation_status IN ('DRAFT','CONSUMED');
    IF delivery_qty IS NULL OR source_client IS DISTINCT FROM target_client OR sourced_qty + NEW.quantity_selected > delivery_qty THEN RAISE EXCEPTION 'invoice source allocations have a client mismatch or exceed delivered quantity' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
