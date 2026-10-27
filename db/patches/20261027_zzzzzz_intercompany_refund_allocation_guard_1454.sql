BEGIN;

-- Restore CUSTOMER-REFUND-1268 net-credit accounting without removing the
-- intercompany external-receipt source added by the preceding frozen patch.
CREATE OR REPLACE FUNCTION public.fn_validate_facturation_allocation_227()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  payment_amount numeric(18,2); payment_facture_id bigint; payment_is_net boolean; payment_is_modern boolean;
  allocated_amount numeric(18,2); invoice_amount numeric(18,2); invoice_allocated numeric(18,2);
  credit_amount numeric(18,2); credit_allocated numeric(18,2); delivery_qty numeric(18,3); sourced_qty numeric(18,3);
  source_client text; target_client text; incoming_invoice_credit numeric(18,2); receipt_message uuid; receipt_line integer;
BEGIN
  IF TG_TABLE_NAME='paiement_allocations' THEN
    SELECT montant::numeric(18,2),facture_id,
      status NOT IN ('REJECTED','REVERSED') AND workflow_status<>'REVERSED' AND reversal_of_id IS NULL,
      uuid IS NOT NULL AND code IS NOT NULL AND correlation_id IS NOT NULL AND idempotency_key IS NOT NULL AND request_hash IS NOT NULL
      INTO payment_amount,payment_facture_id,payment_is_net,payment_is_modern FROM public.paiement WHERE id=NEW.paiement_id FOR UPDATE;
    SELECT COALESCE(SUM(amount_ttc),0)::numeric(18,2) INTO allocated_amount FROM public.paiement_allocations WHERE paiement_id=NEW.paiement_id;
    IF payment_facture_id IS NOT NULL AND allocated_amount=0 AND NOT COALESCE(payment_is_modern,FALSE) THEN
      RAISE EXCEPTION 'direct legacy payment evidence cannot be converted to allocations' USING ERRCODE='55000';
    END IF;
    IF payment_amount IS NULL OR NOT COALESCE(payment_is_net,FALSE) OR allocated_amount+NEW.amount_ttc>payment_amount THEN
      RAISE EXCEPTION 'payment allocations exceed recorded net payment' USING ERRCODE='23514';
    END IF;
    SELECT total_ttc::numeric(18,2) INTO invoice_amount FROM public.facture WHERE id=NEW.facture_id FOR UPDATE;
    SELECT (public.fn_invoice_cash_total_1268(NEW.facture_id,NEW.paiement_id)+public.fn_invoice_credit_total_1268(NEW.facture_id)
      -COALESCE((SELECT sum(amount_ttc) FROM public.customer_refunds WHERE facture_id=NEW.facture_id),0))::numeric(18,2) INTO invoice_allocated;
    IF invoice_amount IS NULL OR invoice_allocated+NEW.amount_ttc>invoice_amount THEN
      RAISE EXCEPTION 'payment and credit allocations exceed invoice total' USING ERRCODE='23514';
    END IF;
  ELSIF TG_TABLE_NAME='avoir_source_allocations' THEN
    SELECT total_ttc::numeric(18,2),client_id INTO credit_amount,source_client FROM public.avoir WHERE id=NEW.avoir_id FOR UPDATE;
    SELECT total_ttc::numeric(18,2),client_id INTO invoice_amount,target_client FROM public.facture WHERE id=NEW.facture_id FOR UPDATE;
    SELECT COALESCE(SUM(amount_ttc),0)::numeric(18,2) INTO credit_allocated FROM public.avoir_source_allocations WHERE avoir_id=NEW.avoir_id AND id IS DISTINCT FROM NEW.id;
    IF source_client IS DISTINCT FROM target_client OR credit_amount IS NULL OR credit_allocated+NEW.amount_ttc>credit_amount THEN
      RAISE EXCEPTION 'credit allocation has a client mismatch or exceeds the credit note' USING ERRCODE='23514';
    END IF;
    incoming_invoice_credit:=CASE WHEN NEW.allocation_status='CONSUMED' THEN NEW.amount_ttc ELSE 0 END;
    SELECT public.fn_invoice_credit_total_1268(NEW.facture_id,NEW.id)::numeric(18,2) INTO invoice_allocated;
    IF invoice_amount IS NULL OR invoice_allocated+incoming_invoice_credit>invoice_amount THEN
      RAISE EXCEPTION 'payment and credit allocations exceed invoice total' USING ERRCODE='23514';
    END IF;
  ELSIF TG_TABLE_NAME='facture_source_allocations' AND NEW.source_type='EXTERNAL_FULFILMENT_RECEIPT_LINE' THEN
    BEGIN receipt_message:=split_part(NEW.source_line_id,':',1)::uuid; receipt_line:=split_part(NEW.source_line_id,':',2)::integer;
    EXCEPTION WHEN others THEN RAISE EXCEPTION 'external fulfilment source identity is invalid' USING ERRCODE='23514'; END;
    SELECT receipt_line_row.quantity::numeric(18,3),command.client_id,invoice.client_id INTO delivery_qty,source_client,target_client
      FROM public.cerp_intercompany_external_fulfilment_receipt_lines receipt_line_row
      JOIN public.cerp_intercompany_external_fulfilment_receipts receipt ON receipt.message_id=receipt_line_row.message_id
      JOIN public.commande_ligne line ON line.id=receipt_line_row.buyer_sales_order_line_id
      JOIN public.commande_client command ON command.id=line.commande_id AND command.fulfilment_mode='SUPPLIER_DROPSHIP'
      JOIN public.facture invoice ON invoice.id=NEW.facture_id
      WHERE receipt_line_row.message_id=receipt_message AND receipt_line_row.line_no=receipt_line
      FOR UPDATE OF receipt_line_row,receipt,line,command,invoice;
    SELECT COALESCE(SUM(quantity_selected),0)::numeric(18,3) INTO sourced_qty FROM public.facture_source_allocations
      WHERE source_type='EXTERNAL_FULFILMENT_RECEIPT_LINE' AND source_line_id=NEW.source_line_id AND allocation_status IN('DRAFT','CONSUMED');
    IF delivery_qty IS NULL OR source_client IS DISTINCT FROM target_client OR sourced_qty+NEW.quantity_selected>delivery_qty THEN
      RAISE EXCEPTION 'external fulfilment invoice allocations have a client mismatch or exceed received quantity' USING ERRCODE='23514';
    END IF;
  ELSIF TG_TABLE_NAME='facture_source_allocations' AND NEW.source_type='DELIVERY_LINE' THEN
    SELECT bll.quantite::numeric(18,3),bl.client_id,f.client_id INTO delivery_qty,source_client,target_client
      FROM public.bon_livraison_ligne bll JOIN public.bon_livraison bl ON bl.id=bll.bon_livraison_id JOIN public.facture f ON f.id=NEW.facture_id
      WHERE bll.id::text=NEW.source_line_id FOR UPDATE OF bll,bl,f;
    SELECT COALESCE(SUM(quantity_selected),0)::numeric(18,3) INTO sourced_qty FROM public.facture_source_allocations
      WHERE source_type='DELIVERY_LINE' AND source_line_id=NEW.source_line_id AND allocation_status IN('DRAFT','CONSUMED');
    IF delivery_qty IS NULL OR source_client IS DISTINCT FROM target_client OR sourced_qty+NEW.quantity_selected>delivery_qty THEN
      RAISE EXCEPTION 'invoice source allocations have a client mismatch or exceed delivered quantity' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
