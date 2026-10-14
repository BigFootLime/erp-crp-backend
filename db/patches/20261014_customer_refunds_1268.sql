-- #1268: credit paid invoices, retain refund bank evidence and distinct budgets.
BEGIN;
SET LOCAL lock_timeout='5s';
CREATE SEQUENCE IF NOT EXISTS public.customer_refund_number_seq;
CREATE TABLE IF NOT EXISTS public.customer_refunds (
  id uuid PRIMARY KEY,code text NOT NULL UNIQUE,facture_id bigint NOT NULL REFERENCES public.facture(id),
  avoir_id bigint NOT NULL REFERENCES public.avoir(id),client_id varchar(120) NOT NULL,currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
  amount_ttc numeric(18,2) NOT NULL CHECK(amount_ttc>0),value_date date NOT NULL,booking_date date NOT NULL CHECK(booking_date>=value_date),
  mode text NOT NULL CHECK(length(btrim(mode)) BETWEEN 1 AND 80),reference text NOT NULL CHECK(length(btrim(reference)) BETWEEN 1 AND 200),
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 8 AND 2000),proof_document_id uuid NULL,
  source_snapshot jsonb NOT NULL CHECK(jsonb_typeof(source_snapshot)='object'),created_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NOT NULL REFERENCES public.users(id),correlation_id uuid NOT NULL
);
CREATE INDEX IF NOT EXISTS customer_refunds_invoice_1268_idx ON public.customer_refunds(facture_id,avoir_id);
CREATE TABLE IF NOT EXISTS public.customer_refund_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),refund_id uuid NOT NULL REFERENCES public.customer_refunds(id),
  origin_type text NOT NULL CHECK(origin_type IN('INVOICE_ALLOCATION','INVOICE_DIRECT','APPLIED_ADVANCE')),origin_id text NOT NULL,
  paiement_id bigint NOT NULL REFERENCES public.paiement(id),payment_allocation_id uuid NULL REFERENCES public.paiement_allocations(id),
  amount_ttc numeric(18,2) NOT NULL CHECK(amount_ttc>0),created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(refund_id,origin_type,origin_id)
);
CREATE INDEX IF NOT EXISTS customer_refund_sources_payment_1268_idx ON public.customer_refund_sources(paiement_id,payment_allocation_id);
GRANT SELECT,INSERT ON public.customer_refunds,public.customer_refund_sources TO cerp_app;
GRANT USAGE,SELECT ON SEQUENCE public.customer_refund_number_seq TO cerp_app;

CREATE OR REPLACE FUNCTION public.fn_invoice_credit_total_1268(v_invoice_id bigint,v_excluded_source uuid DEFAULT NULL)
RETURNS numeric LANGUAGE sql STABLE AS $$
 SELECT COALESCE((SELECT sum(amount_ttc) FROM public.avoir_source_allocations WHERE facture_id=v_invoice_id
   AND allocation_status='CONSUMED' AND id IS DISTINCT FROM v_excluded_source),0)
 +COALESCE((SELECT sum(total_ttc) FROM public.avoir a WHERE a.facture_id=v_invoice_id AND a.statut IN('ISSUED','emis','emise','envoyee')
   AND NOT EXISTS(SELECT 1 FROM public.avoir_source_allocations WHERE avoir_id=a.id)),0)
$$;
CREATE OR REPLACE FUNCTION public.fn_invoice_cash_total_1268(v_invoice_id bigint,v_excluded_direct_payment bigint DEFAULT NULL)
RETURNS numeric LANGUAGE sql STABLE AS $$
 SELECT public.fn_invoice_applied_prepayment_1268(v_invoice_id)
 +COALESCE((SELECT sum(a.amount_ttc) FROM public.paiement_allocations a JOIN public.paiement p ON p.id=a.paiement_id
   WHERE a.facture_id=v_invoice_id AND p.status NOT IN('REJECTED','REVERSED') AND p.workflow_status<>'REVERSED' AND p.reversal_of_id IS NULL),0)
 +COALESCE((SELECT sum(montant) FROM public.paiement p WHERE p.facture_id=v_invoice_id AND p.id IS DISTINCT FROM v_excluded_direct_payment
   AND p.status NOT IN('REJECTED','REVERSED') AND p.workflow_status<>'REVERSED' AND p.reversal_of_id IS NULL
   AND NOT EXISTS(SELECT 1 FROM public.paiement_allocations WHERE paiement_id=p.id)),0)
$$;

CREATE OR REPLACE FUNCTION public.fn_customer_refund_write_1268()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE refund public.customer_refunds%ROWTYPE;credit public.avoir%ROWTYPE;payment public.paiement%ROWTYPE;invoice public.facture%ROWTYPE;
  owned boolean;source_limit numeric;used numeric;applied numeric;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'CUSTOMER-REFUND-1268 immutable bank refund evidence' USING ERRCODE='55000'; END IF;
  IF TG_TABLE_NAME='customer_refunds' THEN
    SELECT * INTO credit FROM public.avoir WHERE id=NEW.avoir_id FOR UPDATE;
    SELECT * INTO invoice FROM public.facture WHERE id=NEW.facture_id FOR UPDATE;
    IF credit.statut NOT IN('ISSUED','emis','emise','envoyee') OR credit.id IS NULL OR credit.facture_id<>NEW.facture_id
      OR credit.client_id IS DISTINCT FROM NEW.client_id OR credit.currency IS DISTINCT FROM NEW.currency
      OR invoice.id IS NULL OR invoice.document_status<>'ISSUED' OR invoice.client_id IS DISTINCT FROM NEW.client_id
      OR invoice.currency IS DISTINCT FROM NEW.currency THEN
      RAISE EXCEPTION 'CUSTOMER-REFUND-1268 issued credit party or invoice mismatch' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  -- The immutable header needs SELECT only. The shared finance statement lock
  -- already serializes refund writes; row-locking it would require an UPDATE
  -- grant that cerp_app intentionally does not have.
  SELECT * INTO refund FROM public.customer_refunds WHERE id=NEW.refund_id;
  SELECT * INTO payment FROM public.paiement WHERE id=NEW.paiement_id FOR UPDATE;
  IF refund.id IS NULL OR payment.id IS NULL OR payment.client_id IS DISTINCT FROM refund.client_id OR payment.currency IS DISTINCT FROM refund.currency
    OR payment.status IN('REJECTED','REVERSED') OR payment.workflow_status='REVERSED' OR payment.reversal_of_id IS NOT NULL THEN
    RAISE EXCEPTION 'CUSTOMER-REFUND-1268 active cash party mismatch' USING ERRCODE='23514';
  END IF;
  IF NEW.origin_type='INVOICE_ALLOCATION' THEN
    SELECT a.facture_id=refund.facture_id AND a.paiement_id=payment.id AND a.id=NEW.payment_allocation_id,a.amount_ttc
      INTO owned,source_limit FROM public.paiement_allocations a WHERE a.id::text=NEW.origin_id;
    SELECT COALESCE(sum(p.amount_ttc),0) INTO applied FROM public.proforma_final_prepayments p
      JOIN public.proforma_receipt_assignments r ON r.id=p.receipt_assignment_id JOIN public.facture_source_allocations f ON f.id=p.final_source_allocation_id
      WHERE r.payment_allocation_id=NEW.payment_allocation_id AND f.allocation_status IN('DRAFT','CONSUMED');
    source_limit:=source_limit-applied;
  ELSIF NEW.origin_type='INVOICE_DIRECT' THEN
    owned:=NEW.payment_allocation_id IS NULL AND NEW.origin_id=payment.id::text AND payment.facture_id=refund.facture_id
      AND NOT EXISTS(SELECT 1 FROM public.paiement_allocations WHERE paiement_id=payment.id);
    source_limit:=payment.montant;
  ELSE
    SELECT f.facture_id=refund.facture_id AND f.allocation_status='CONSUMED' AND a.paiement_id=payment.id AND a.id=NEW.payment_allocation_id,p.amount_ttc
      INTO owned,source_limit FROM public.proforma_final_prepayments p JOIN public.facture_source_allocations f ON f.id=p.final_source_allocation_id
      JOIN public.proforma_receipt_assignments r ON r.id=p.receipt_assignment_id JOIN public.paiement_allocations a ON a.id=r.payment_allocation_id
      WHERE p.id::text=NEW.origin_id;
  END IF;
  SELECT COALESCE(sum(amount_ttc),0) INTO used FROM public.customer_refund_sources WHERE origin_type=NEW.origin_type AND origin_id=NEW.origin_id;
  IF NOT COALESCE(owned,false) OR source_limit IS NULL OR used+NEW.amount_ttc>source_limit
    OR (SELECT COALESCE(sum(amount_ttc),0) FROM public.customer_refund_sources WHERE paiement_id=payment.id)+NEW.amount_ttc>payment.montant
    OR (NEW.payment_allocation_id IS NOT NULL AND
      (SELECT COALESCE(sum(amount_ttc),0) FROM public.customer_refund_sources WHERE payment_allocation_id=NEW.payment_allocation_id)+NEW.amount_ttc>
      (SELECT amount_ttc FROM public.paiement_allocations WHERE id=NEW.payment_allocation_id)) THEN
    RAISE EXCEPTION 'CUSTOMER-REFUND-1268 original cash budget exceeded' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_check_customer_refunds_1268()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE row_data jsonb;invoice_ids bigint[];invoice_id bigint;invoice public.facture%ROWTYPE;
  credits numeric;cash numeric;refunds numeric;header public.customer_refunds%ROWTYPE;
BEGIN
  row_data:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  IF TG_TABLE_NAME='facture' THEN invoice_ids:=ARRAY[(row_data->>'id')::bigint];
  ELSIF TG_TABLE_NAME IN('avoir','avoir_source_allocations','paiement_allocations','customer_refunds') THEN invoice_ids:=ARRAY[(row_data->>'facture_id')::bigint];
  ELSIF TG_TABLE_NAME='customer_refund_sources' THEN SELECT ARRAY[facture_id] INTO invoice_ids FROM public.customer_refunds WHERE id=(row_data->>'refund_id')::uuid;
  ELSE SELECT array_agg(id) INTO invoice_ids FROM(SELECT facture_id AS id FROM public.paiement_allocations WHERE paiement_id=(row_data->>'id')::bigint
    UNION SELECT (row_data->>'facture_id')::bigint) affected;
  END IF;
  FOREACH invoice_id IN ARRAY COALESCE(invoice_ids,ARRAY[]::bigint[]) LOOP
    IF invoice_id IS NULL THEN CONTINUE; END IF;
    SELECT * INTO invoice FROM public.facture WHERE id=invoice_id FOR UPDATE;
    IF invoice.id IS NULL OR invoice.document_status<>'ISSUED' THEN CONTINUE; END IF;
    credits:=public.fn_invoice_credit_total_1268(invoice_id);cash:=public.fn_invoice_cash_total_1268(invoice_id);
    SELECT COALESCE(sum(amount_ttc),0) INTO refunds FROM public.customer_refunds WHERE facture_id=invoice_id;
    IF credits>invoice.total_ttc OR credits<0 OR cash-refunds>invoice.total_ttc OR refunds>cash OR refunds>credits
      OR refunds>greatest(0,cash+credits-invoice.total_ttc) THEN
      RAISE EXCEPTION 'CUSTOMER-REFUND-1268 invoice credits or refundable cash exceeded' USING ERRCODE='23514';
    END IF;
    FOR header IN SELECT * FROM public.customer_refunds WHERE facture_id=invoice_id LOOP
      IF header.amount_ttc<>(SELECT COALESCE(sum(amount_ttc),0) FROM public.customer_refund_sources WHERE refund_id=header.id)
        OR (SELECT COALESCE(sum(amount_ttc),0) FROM public.customer_refunds WHERE avoir_id=header.avoir_id)>
          (SELECT total_ttc FROM public.avoir WHERE id=header.avoir_id)
        OR EXISTS(SELECT 1 FROM public.customer_refund_sources s JOIN public.paiement p ON p.id=s.paiement_id WHERE s.refund_id=header.id
          AND (p.status IN('REJECTED','REVERSED') OR p.workflow_status='REVERSED' OR p.reversal_of_id IS NOT NULL
            OR p.client_id IS DISTINCT FROM header.client_id OR p.currency IS DISTINCT FROM header.currency)) THEN
        RAISE EXCEPTION 'CUSTOMER-REFUND-1268 refund must retain its exact original cash and credit budgets' USING ERRCODE='23514';
      END IF;
    END LOOP;
  END LOOP;
  RETURN NULL;
END;
$$;
DO $$ DECLARE table_name text;BEGIN
 FOREACH table_name IN ARRAY ARRAY['customer_refunds','customer_refund_sources'] LOOP
   EXECUTE format('DROP TRIGGER IF EXISTS trg_customer_refund_write_1268 ON public.%I',table_name);
   EXECUTE format('CREATE TRIGGER trg_customer_refund_write_1268 BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.fn_customer_refund_write_1268()',table_name);
   EXECUTE format('DROP TRIGGER IF EXISTS trg_delivery_prepayment_epoch_1268 ON public.%I',table_name);
   EXECUTE format('CREATE TRIGGER trg_delivery_prepayment_epoch_1268 BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.fn_touch_delivery_prepayment_1268()',table_name);
 END LOOP;
 FOREACH table_name IN ARRAY ARRAY['facture','avoir','avoir_source_allocations','paiement','paiement_allocations','customer_refunds','customer_refund_sources'] LOOP
   EXECUTE format('DROP TRIGGER IF EXISTS trg_check_customer_refunds_1268 ON public.%I',table_name);
   EXECUTE format('CREATE CONSTRAINT TRIGGER trg_check_customer_refunds_1268 AFTER INSERT OR UPDATE OR DELETE ON public.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.fn_check_customer_refunds_1268()',table_name);
 END LOOP;
END $$;

-- Preserve the exact prerequisite functions for a data-loss-refusing rollback.
CREATE TABLE IF NOT EXISTS public.finance_refund_migration_state_1268 (id boolean PRIMARY KEY DEFAULT true CHECK(id),prior_allocation_function text NOT NULL,prior_final_function text NOT NULL,prior_cash_vat_function text);
ALTER TABLE public.finance_refund_migration_state_1268 ADD COLUMN IF NOT EXISTS prior_cash_vat_function text;
INSERT INTO public.finance_refund_migration_state_1268(id,prior_allocation_function,prior_final_function,prior_cash_vat_function)
  SELECT true,pg_get_functiondef('public.fn_validate_facturation_allocation_227()'::regprocedure),pg_get_functiondef('public.fn_check_final_prepayments_1268()'::regprocedure),pg_get_functiondef('public.fn_advance_cash_vat_1268()'::regprocedure)
  ON CONFLICT(id) DO NOTHING;
UPDATE public.finance_refund_migration_state_1268 SET prior_cash_vat_function=pg_get_functiondef('public.fn_advance_cash_vat_1268()'::regprocedure) WHERE prior_cash_vat_function IS NULL;
ALTER TABLE public.finance_refund_migration_state_1268 ALTER COLUMN prior_cash_vat_function SET NOT NULL;
REVOKE ALL ON public.finance_refund_migration_state_1268 FROM cerp_app;
-- Canonical prerequisite function adaptations are appended by the repository generator.

-- Generated canonical adaptations; original payment/source and ownership guards retained.
CREATE OR REPLACE FUNCTION public.fn_validate_facturation_allocation_227()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  payment_amount numeric(18,2);
  payment_facture_id bigint;
  payment_is_net boolean;
  payment_is_modern boolean;
  allocated_amount numeric(18,2);
  invoice_amount numeric(18,2);
  invoice_allocated numeric(18,2);
  credit_amount numeric(18,2);
  credit_allocated numeric(18,2);
  delivery_qty numeric(18,3);
  sourced_qty numeric(18,3);
  source_client text;
  target_client text;
  incoming_invoice_credit numeric(18,2);
BEGIN
  IF TG_TABLE_NAME = 'paiement_allocations' THEN
    SELECT
      montant::numeric(18,2),
      facture_id,
      status NOT IN ('REJECTED','REVERSED')
        AND workflow_status <> 'REVERSED'
        AND reversal_of_id IS NULL,
      uuid IS NOT NULL
        AND code IS NOT NULL
        AND correlation_id IS NOT NULL
        AND idempotency_key IS NOT NULL
        AND request_hash IS NOT NULL
    INTO payment_amount, payment_facture_id, payment_is_net, payment_is_modern
    FROM public.paiement
    WHERE id = NEW.paiement_id
    FOR UPDATE;

    SELECT COALESCE(SUM(amount_ttc), 0)::numeric(18,2)
    INTO allocated_amount
    FROM public.paiement_allocations
    WHERE paiement_id = NEW.paiement_id;

    IF payment_facture_id IS NOT NULL
       AND allocated_amount = 0
       AND NOT COALESCE(payment_is_modern, FALSE) THEN
      RAISE EXCEPTION 'direct legacy payment evidence cannot be converted to allocations' USING ERRCODE = '55000';
    END IF;
    IF payment_amount IS NULL
       OR NOT COALESCE(payment_is_net, FALSE)
       OR allocated_amount + NEW.amount_ttc > payment_amount THEN
      RAISE EXCEPTION 'payment allocations exceed recorded net payment' USING ERRCODE = '23514';
    END IF;

    SELECT total_ttc::numeric(18,2)
    INTO invoice_amount
    FROM public.facture
    WHERE id = NEW.facture_id
    FOR UPDATE;

    SELECT (public.fn_invoice_cash_total_1268(NEW.facture_id,NEW.paiement_id)
      +public.fn_invoice_credit_total_1268(NEW.facture_id)
      -COALESCE((SELECT sum(amount_ttc) FROM public.customer_refunds WHERE facture_id=NEW.facture_id),0))::numeric(18,2)
    INTO invoice_allocated;

    IF invoice_amount IS NULL OR invoice_allocated + NEW.amount_ttc > invoice_amount THEN
      RAISE EXCEPTION 'payment and credit allocations exceed invoice total' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'avoir_source_allocations' THEN
    SELECT total_ttc::numeric(18,2), client_id
    INTO credit_amount, source_client
    FROM public.avoir
    WHERE id = NEW.avoir_id
    FOR UPDATE;

    SELECT total_ttc::numeric(18,2), client_id
    INTO invoice_amount, target_client
    FROM public.facture
    WHERE id = NEW.facture_id
    FOR UPDATE;

    SELECT COALESCE(SUM(amount_ttc), 0)::numeric(18,2)
    INTO credit_allocated
    FROM public.avoir_source_allocations
    WHERE avoir_id = NEW.avoir_id
      AND id IS DISTINCT FROM NEW.id;

    IF source_client IS DISTINCT FROM target_client
       OR credit_amount IS NULL
       OR credit_allocated + NEW.amount_ttc > credit_amount THEN
      RAISE EXCEPTION 'credit allocation has a client mismatch or exceeds the credit note' USING ERRCODE = '23514';
    END IF;

    incoming_invoice_credit := CASE
      WHEN NEW.allocation_status = 'CONSUMED' THEN NEW.amount_ttc
      ELSE 0
    END;

    SELECT public.fn_invoice_credit_total_1268(NEW.facture_id,NEW.id)::numeric(18,2)
    INTO invoice_allocated;

    IF invoice_amount IS NULL
       OR invoice_allocated + incoming_invoice_credit > invoice_amount THEN
      RAISE EXCEPTION 'payment and credit allocations exceed invoice total' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'facture_source_allocations' THEN
    SELECT bll.quantite::numeric(18,3), bl.client_id, f.client_id
    INTO delivery_qty, source_client, target_client
    FROM public.bon_livraison_ligne bll
    JOIN public.bon_livraison bl ON bl.id = bll.bon_livraison_id
    JOIN public.facture f ON f.id = NEW.facture_id
    WHERE NEW.source_type = 'DELIVERY_LINE' AND bll.id::text = NEW.source_line_id
    FOR UPDATE OF bll, bl, f;
    SELECT COALESCE(SUM(quantity_selected), 0)::numeric(18,3) INTO sourced_qty
    FROM public.facture_source_allocations
    WHERE source_type = 'DELIVERY_LINE' AND source_line_id = NEW.source_line_id
      AND allocation_status IN ('DRAFT','CONSUMED');
    IF delivery_qty IS NULL OR source_client IS DISTINCT FROM target_client OR sourced_qty + NEW.quantity_selected > delivery_qty THEN
      RAISE EXCEPTION 'invoice source allocations have a client mismatch or exceed delivered quantity' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION public.fn_check_final_prepayments_1268()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE row_data jsonb; invoice_ids bigint[]; v_invoice_id bigint; invoice public.facture%ROWTYPE;
 v_applied numeric; v_due numeric; v_settled numeric;
BEGIN
 row_data:=COALESCE(to_jsonb(NEW),to_jsonb(OLD));
 IF TG_TABLE_NAME='facture' THEN invoice_ids:=ARRAY[(row_data->>'id')::bigint];
 ELSIF TG_TABLE_NAME IN('facture_source_allocations','facture_echeance','paiement_allocations','avoir','avoir_source_allocations') THEN
  invoice_ids:=ARRAY[(row_data->>'facture_id')::bigint];
 ELSIF TG_TABLE_NAME='proforma_final_prepayments' THEN
  SELECT ARRAY[facture_id] INTO invoice_ids FROM public.facture_source_allocations WHERE id=(row_data->>'final_source_allocation_id')::uuid;
 ELSIF TG_TABLE_NAME='paiement' THEN
  SELECT array_agg(id) INTO invoice_ids FROM(SELECT facture_id AS id FROM public.paiement_allocations WHERE paiement_id=(row_data->>'id')::integer
    UNION SELECT (row_data->>'facture_id')::bigint) impacted;
 ELSIF TG_TABLE_NAME IN('proforma_receipt_assignments','proforma_receipt_releases') THEN
  SELECT ARRAY[deposit.facture_id] INTO invoice_ids FROM public.proforma_receipt_assignments receipt
   JOIN public.facture_source_allocations deposit ON deposit.id=receipt.deposit_source_id
   WHERE receipt.id=CASE WHEN TG_TABLE_NAME='proforma_receipt_releases' THEN (row_data->>'assignment_id')::uuid ELSE (row_data->>'id')::uuid END;
 END IF;
 -- A change to an advance or its receipt also protects every final application.
 SELECT array_agg(DISTINCT id) INTO invoice_ids FROM(
  SELECT unnest(invoice_ids) AS id UNION
  SELECT final.facture_id FROM public.proforma_final_prepayments applied
  JOIN public.facture_source_allocations final ON final.id=applied.final_source_allocation_id
  JOIN public.facture_source_allocations deposit ON deposit.id=applied.deposit_source_id
  WHERE deposit.facture_id=ANY(invoice_ids)
 ) impacted WHERE id IS NOT NULL;
 FOREACH v_invoice_id IN ARRAY COALESCE(invoice_ids,ARRAY[]::bigint[]) LOOP
  SELECT * INTO invoice FROM public.facture WHERE id=v_invoice_id;
  IF NOT FOUND OR invoice.amount_due_at_issue IS NULL OR invoice.document_status='CANCELLED' THEN CONTINUE; END IF;
  SELECT COALESCE(sum(applied.amount_ttc),0) INTO v_applied FROM public.proforma_final_prepayments applied
   JOIN public.facture_source_allocations final ON final.id=applied.final_source_allocation_id
   WHERE final.facture_id=v_invoice_id AND final.allocation_status IN('DRAFT','CONSUMED');
  SELECT COALESCE(sum(amount_due),0) INTO v_due FROM public.facture_echeance WHERE facture_id=v_invoice_id;
  IF v_applied<>invoice.prepaid_amount_ttc OR v_due<>invoice.amount_due_at_issue THEN
   RAISE EXCEPTION 'final invoice advances and installments must equal retained net due' USING ERRCODE='23514';
  END IF;
  IF EXISTS(SELECT 1 FROM public.proforma_final_prepayments applied
    JOIN public.facture_source_allocations final ON final.id=applied.final_source_allocation_id
    JOIN public.proforma_receipt_assignments receipt ON receipt.id=applied.receipt_assignment_id
    JOIN public.paiement_allocations allocation ON allocation.id=receipt.payment_allocation_id
    JOIN public.paiement payment ON payment.id=allocation.paiement_id
    JOIN public.facture_source_allocations deposit ON deposit.id=applied.deposit_source_id
    JOIN public.facture advance_invoice ON advance_invoice.id=deposit.facture_id
    WHERE final.facture_id=v_invoice_id AND final.allocation_status IN('DRAFT','CONSUMED') AND(
      payment.status NOT IN('UNALLOCATED','PARTIALLY_ALLOCATED','ALLOCATED') OR payment.workflow_status NOT IN('RECORDED','ALLOCATED')
      OR payment.reversal_of_id IS NOT NULL OR deposit.allocation_status<>'CONSUMED' OR advance_invoice.document_status<>'ISSUED'
      OR (SELECT COALESCE(sum(used.amount_ttc),0) FROM public.proforma_final_prepayments used
        JOIN public.facture_source_allocations active ON active.id=used.final_source_allocation_id
        WHERE used.receipt_assignment_id=receipt.id AND active.allocation_status IN('DRAFT','CONSUMED'))>
        receipt.amount_ttc-(SELECT COALESCE(sum(amount_ttc),0) FROM public.proforma_receipt_releases WHERE assignment_id=receipt.id)
      OR (SELECT COALESCE(sum(used.amount_ttc),0) FROM public.proforma_final_prepayments used
        JOIN public.facture_source_allocations active ON active.id=used.final_source_allocation_id
        WHERE used.deposit_source_id=deposit.id AND active.allocation_status IN('DRAFT','CONSUMED'))>
        deposit.amount_incl_tax-(SELECT COALESCE(sum(amount_ttc),0) FROM public.avoir_source_allocations
          WHERE facture_id=deposit.facture_id AND facture_ligne_id=deposit.facture_ligne_id AND allocation_status='CONSUMED')
    )) THEN RAISE EXCEPTION 'applied advance still requires its original unused net receipt' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM public.fn_final_prepayment_targets_1268(v_invoice_id) target
    WHERE target.amount_ttc<(SELECT COALESCE(sum(amount_ttc),0) FROM public.proforma_final_prepayments applied
      WHERE applied.final_source_allocation_id=target.final_source_allocation_id AND applied.proforma_billing_part_id=target.proforma_billing_part_id)) THEN
   RAISE EXCEPTION 'applied advance exceeds delivered company value' USING ERRCODE='23514';
  END IF;
  IF invoice.document_status='ISSUED' AND(
    invoice.immutable_snapshot->'prepayments'->>'version' IS DISTINCT FROM '1'
    OR (invoice.immutable_snapshot->'prepayments'->>'amount_paid')::numeric IS DISTINCT FROM invoice.prepaid_amount_ttc
    OR (invoice.immutable_snapshot->'prepayments'->>'amount_due')::numeric IS DISTINCT FROM invoice.amount_due_at_issue) THEN
   RAISE EXCEPTION 'issued final invoice must freeze its actual advance and net due' USING ERRCODE='23514';
  END IF;
  IF invoice.document_status='ISSUED' THEN
   SELECT public.fn_invoice_applied_prepayment_1268(v_invoice_id)
    +COALESCE((SELECT sum(allocation.amount_ttc) FROM public.paiement_allocations allocation JOIN public.paiement payment ON payment.id=allocation.paiement_id
      WHERE allocation.facture_id=v_invoice_id AND payment.status NOT IN('REJECTED','REVERSED') AND payment.workflow_status<>'REVERSED' AND payment.reversal_of_id IS NULL),0)
    +COALESCE((SELECT sum(montant) FROM public.paiement payment WHERE payment.facture_id=v_invoice_id AND payment.status NOT IN('REJECTED','REVERSED')
      AND payment.workflow_status<>'REVERSED' AND payment.reversal_of_id IS NULL AND NOT EXISTS(SELECT 1 FROM public.paiement_allocations WHERE paiement_id=payment.id)),0)
    +COALESCE((SELECT sum(amount_ttc) FROM public.avoir_source_allocations WHERE facture_id=v_invoice_id AND allocation_status='CONSUMED'),0)
    +COALESCE((SELECT sum(total_ttc) FROM public.avoir credit WHERE credit.facture_id=v_invoice_id AND credit.statut IN('ISSUED','emis','emise','envoyee')
      AND NOT EXISTS(SELECT 1 FROM public.avoir_source_allocations WHERE avoir_id=credit.id)),0)
    INTO v_settled;
   IF v_settled-public.fn_invoice_credit_total_1268(v_invoice_id)
      -COALESCE((SELECT sum(amount_ttc) FROM public.customer_refunds WHERE facture_id=v_invoice_id),0)>invoice.total_ttc
      OR public.fn_invoice_credit_total_1268(v_invoice_id)>invoice.total_ttc THEN
    RAISE EXCEPTION 'cash or credits exceed final invoice after retained refunds' USING ERRCODE='23514';
   END IF;
  END IF;
 END LOOP;
 RETURN NULL;
END;
$$;
ALTER TABLE public.accounting_export_batch_sources DROP CONSTRAINT IF EXISTS accounting_batch_source_type_1268_ck;
ALTER TABLE public.accounting_export_batch_sources ADD CONSTRAINT accounting_batch_source_type_1268_ck CHECK (source_type IN('INVOICE','CREDIT_NOTE','PAYMENT','SUPPLIER_INVOICE','SUPPLIER_CREDIT_NOTE','ADVANCE_VAT','CUSTOMER_REFUND'));
ALTER TABLE public.accounting_export_entries DROP CONSTRAINT IF EXISTS accounting_entry_source_type_1268_ck;
ALTER TABLE public.accounting_export_entries ADD CONSTRAINT accounting_entry_source_type_1268_ck CHECK (source_type IN('INVOICE','CREDIT_NOTE','PAYMENT','SUPPLIER_INVOICE','SUPPLIER_CREDIT_NOTE','ADVANCE_VAT','CUSTOMER_REFUND'));
ALTER TABLE public.accounting_export_source_claims DROP CONSTRAINT IF EXISTS accounting_claim_source_type_1268_ck;
ALTER TABLE public.accounting_export_source_claims ADD CONSTRAINT accounting_claim_source_type_1268_ck CHECK (source_type IN('INVOICE','CREDIT_NOTE','PAYMENT','SUPPLIER_INVOICE','SUPPLIER_CREDIT_NOTE','ADVANCE_VAT','CUSTOMER_REFUND'));
ALTER TABLE public.accounting_export_batches DROP CONSTRAINT IF EXISTS accounting_batch_sources_1268_ck;
ALTER TABLE public.accounting_export_batches ADD CONSTRAINT accounting_batch_sources_1268_ck CHECK (
 cardinality(source_types) BETWEEN 1 AND 7 AND source_types <@ ARRAY['INVOICE','CREDIT_NOTE','PAYMENT','SUPPLIER_INVOICE','SUPPLIER_CREDIT_NOTE','ADVANCE_VAT','CUSTOMER_REFUND']::text[]);
-- Qualified receipts after advance credits; original cash facts remain immutable.
CREATE OR REPLACE FUNCTION public.fn_advance_cash_vat_1268()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  invoice public.facture%ROWTYPE; payment public.paiement%ROWTYPE; snapshot jsonb;
  prior_cash numeric; prior_tax numeric; total_tax numeric; total_effect numeric;
  rate numeric; amount numeric; original_amount numeric; prior_amount numeric; item jsonb;
  credit_gross numeric; credit_pending numeric; credit_collected numeric; refunded numeric;
  due_before numeric; pending_before numeric; expected_effect numeric; credit_rate_pending numeric; basis jsonb;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    IF OLD.advance_vat_snapshot IS NOT NULL OR (TG_OP='UPDATE' AND NEW.advance_vat_snapshot IS NOT NULL) THEN
      RAISE EXCEPTION 'ADVANCE-VAT-1268 cash allocation evidence is immutable' USING ERRCODE='55000';
    END IF;
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO invoice FROM public.facture WHERE id=NEW.facture_id FOR UPDATE;
  IF invoice.immutable_snapshot->>'invoice_type_code' IS DISTINCT FROM '386' THEN
    IF NEW.advance_vat_snapshot IS NOT NULL THEN
      RAISE EXCEPTION 'ADVANCE-VAT-1268 only issued advance invoices have cash VAT' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO payment FROM public.paiement WHERE id=NEW.paiement_id;
  snapshot:=NEW.advance_vat_snapshot;
  IF invoice.document_status<>'ISSUED' OR payment.client_id IS DISTINCT FROM invoice.client_id
    OR payment.currency IS DISTINCT FROM invoice.currency OR payment.reversal_of_id IS NOT NULL
    OR payment.status IN('REJECTED','REVERSED') OR payment.workflow_status='REVERSED'
    OR jsonb_typeof(snapshot) IS DISTINCT FROM 'object' OR COALESCE(snapshot->>'version','') NOT IN('1','2')
    OR (snapshot->>'invoice_id')::bigint IS DISTINCT FROM invoice.id
    OR snapshot->>'invoice_sha256' IS DISTINCT FROM lower(invoice.document_checksum_sha256)
    OR (snapshot->>'allocation_amount')::numeric IS DISTINCT FROM NEW.amount_ttc
    OR jsonb_typeof(snapshot->'entries') IS DISTINCT FROM 'array'
    OR jsonb_typeof(invoice.immutable_snapshot->'tax_breakdown'->'entries') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'ADVANCE-VAT-1268 missing or inconsistent frozen cash facts' USING ERRCODE='23514';
  END IF;
  IF EXISTS(SELECT 1 FROM public.paiement_allocations a JOIN public.paiement p ON p.id=a.paiement_id
      WHERE a.facture_id=invoice.id AND p.status NOT IN('REJECTED','REVERSED') AND p.workflow_status<>'REVERSED' AND p.reversal_of_id IS NULL
        AND (a.advance_vat_snapshot IS NULL OR a.advance_vat_snapshot->>'invoice_sha256' IS DISTINCT FROM snapshot->>'invoice_sha256'))
    OR EXISTS(SELECT 1 FROM public.paiement p WHERE p.facture_id=invoice.id AND p.id<>NEW.paiement_id
      AND p.status NOT IN('REJECTED','REVERSED') AND p.workflow_status<>'REVERSED' AND p.reversal_of_id IS NULL
      AND NOT EXISTS(SELECT 1 FROM public.paiement_allocations WHERE paiement_id=p.id))
    OR EXISTS(SELECT 1 FROM public.avoir credit WHERE facture_id=invoice.id AND statut IN('ISSUED','emis','emise','envoyee')
      AND (credit.immutable_snapshot->'advance_credit_vat'->>'version' IS DISTINCT FROM '1'
        OR credit.immutable_snapshot->'advance_credit_vat'->>'invoice_sha256' IS DISTINCT FROM snapshot->>'invoice_sha256'
        OR (credit.immutable_snapshot->'advance_credit_vat'->>'invoice_id')::bigint IS DISTINCT FROM invoice.id
        OR jsonb_typeof(credit.immutable_snapshot->'advance_credit_vat'->'entries') IS DISTINCT FROM 'array'
        OR (credit.immutable_snapshot->'advance_credit_vat'->>'total_incl_tax')::numeric IS DISTINCT FROM credit.total_ttc
        OR (credit.immutable_snapshot->'advance_credit_vat'->>'total_ex_tax')::numeric IS DISTINCT FROM credit.total_ht
        OR (credit.immutable_snapshot->'advance_credit_vat'->>'total_tax')::numeric IS DISTINCT FROM credit.total_tax)) THEN
    RAISE EXCEPTION 'ADVANCE-VAT-1268 prior cash or credit evidence requires qualification' USING ERRCODE='23514';
  END IF;
  SELECT COALESCE(sum(a.amount_ttc),0),COALESCE(sum((a.advance_vat_snapshot->>'tax_after')::numeric-(a.advance_vat_snapshot->>'tax_before')::numeric),0)
    INTO prior_cash,prior_tax FROM public.paiement_allocations a JOIN public.paiement p ON p.id=a.paiement_id
    WHERE a.facture_id=invoice.id AND p.status NOT IN('REJECTED','REVERSED') AND p.workflow_status<>'REVERSED' AND p.reversal_of_id IS NULL;
  total_tax:=COALESCE(invoice.total_tax,invoice.total_ttc-invoice.total_ht);
  SELECT COALESCE(sum((e->>'tax_amount')::numeric),0) INTO total_effect FROM jsonb_array_elements(snapshot->'entries') e;
  SELECT COALESCE(sum(total_ttc),0) INTO credit_gross FROM public.avoir WHERE facture_id=invoice.id AND statut IN('ISSUED','emis','emise','envoyee');
  SELECT COALESCE(sum((e->>'pending_tax')::numeric),0),COALESCE(sum((e->>'collected_tax')::numeric),0)
    INTO credit_pending,credit_collected FROM public.avoir credit,
      LATERAL jsonb_array_elements(credit.immutable_snapshot->'advance_credit_vat'->'entries') e
    WHERE credit.facture_id=invoice.id AND credit.statut IN('ISSUED','emis','emise','envoyee');
  SELECT COALESCE(sum(amount_ttc),0) INTO refunded FROM public.customer_refunds WHERE facture_id=invoice.id;
  due_before:=invoice.total_ttc-credit_gross-prior_cash+refunded;
  pending_before:=total_tax-credit_pending-prior_tax;
  IF snapshot->>'version'='1' THEN
    IF credit_gross<>0 OR refunded<>0 THEN RAISE EXCEPTION 'ADVANCE-VAT-1268 credit-aware cash snapshot required' USING ERRCODE='23514'; END IF;
    expected_effect:=round(total_tax*(prior_cash+NEW.amount_ttc)/invoice.total_ttc,2)-prior_tax;
  ELSE
    basis:=snapshot->'adjustment';
    IF credit_gross<=0 OR due_before<=0 OR pending_before<0 OR jsonb_typeof(basis) IS DISTINCT FROM 'object'
      OR jsonb_typeof(basis->'credit_pending_by_tax') IS DISTINCT FROM 'array'
      OR (basis->>'credited_gross')::numeric IS DISTINCT FROM credit_gross
      OR (basis->>'refunded_gross')::numeric IS DISTINCT FROM refunded
      OR (basis->>'credited_pending_tax')::numeric IS DISTINCT FROM credit_pending
      OR (basis->>'credited_collected_tax')::numeric IS DISTINCT FROM credit_collected
      OR (basis->>'due_before')::numeric IS DISTINCT FROM due_before
      OR (basis->>'pending_tax_before')::numeric IS DISTINCT FROM pending_before
      OR credit_collected>prior_tax OR refunded>prior_cash OR refunded>credit_gross
      OR refunded>greatest(0,prior_cash+credit_gross-invoice.total_ttc)
      OR (SELECT COALESCE(sum((e->>'tax_amount')::numeric),0) FROM jsonb_array_elements(basis->'credit_pending_by_tax') e)<>credit_pending
      OR (SELECT count(*) FROM jsonb_array_elements(basis->'credit_pending_by_tax'))<>
        (SELECT count(DISTINCT (e->>'tax_rate')::numeric) FROM jsonb_array_elements(basis->'credit_pending_by_tax') e) THEN
      RAISE EXCEPTION 'ADVANCE-VAT-1268 inconsistent credit-adjusted cash basis' USING ERRCODE='23514';
    END IF;
    FOR item IN SELECT value FROM jsonb_array_elements(basis->'credit_pending_by_tax') LOOP
      SELECT COALESCE(sum((e->>'pending_tax')::numeric),0) INTO credit_rate_pending FROM public.avoir credit,
        LATERAL jsonb_array_elements(credit.immutable_snapshot->'advance_credit_vat'->'entries') e
        WHERE credit.facture_id=invoice.id AND credit.statut IN('ISSUED','emis','emise','envoyee') AND (e->>'tax_rate')::numeric=(item->>'tax_rate')::numeric;
      IF (item->>'tax_amount')::numeric IS DISTINCT FROM credit_rate_pending OR NOT EXISTS(
        SELECT 1 FROM jsonb_array_elements(invoice.immutable_snapshot->'tax_breakdown'->'entries') e WHERE (e->>'rate_percent')::numeric=(item->>'tax_rate')::numeric) THEN
        RAISE EXCEPTION 'ADVANCE-VAT-1268 inconsistent credit VAT category' USING ERRCODE='23514';
      END IF;
    END LOOP;
    expected_effect:=round(pending_before*NEW.amount_ttc/due_before,2);
  END IF;
  IF invoice.total_ttc<=0 OR prior_cash+NEW.amount_ttc>invoice.total_ttc-credit_gross+refunded
    OR (snapshot->>'cash_before')::numeric IS DISTINCT FROM prior_cash
    OR (snapshot->>'cash_after')::numeric IS DISTINCT FROM prior_cash+NEW.amount_ttc
    OR (snapshot->>'tax_before')::numeric IS DISTINCT FROM prior_tax
    OR (snapshot->>'version'='1' AND prior_tax<>round(total_tax*prior_cash/invoice.total_ttc,2))
    OR (snapshot->>'tax_after')::numeric IS DISTINCT FROM prior_tax+expected_effect
    OR total_effect<>(snapshot->>'tax_after')::numeric-prior_tax
    OR (SELECT count(*) FROM jsonb_array_elements(snapshot->'entries'))
      <> (SELECT count(DISTINCT (e->>'tax_rate')::numeric) FROM jsonb_array_elements(snapshot->'entries') e)
    OR (SELECT COALESCE(sum((e->>'tax_amount')::numeric),0) FROM jsonb_array_elements(invoice.immutable_snapshot->'tax_breakdown'->'entries') e)<>total_tax THEN
    RAISE EXCEPTION 'ADVANCE-VAT-1268 cumulative cash and VAT mismatch' USING ERRCODE='23514';
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(snapshot->'entries') LOOP
    rate:=(item->>'tax_rate')::numeric; amount:=(item->>'tax_amount')::numeric;
    SELECT sum((e->>'tax_amount')::numeric) INTO original_amount FROM jsonb_array_elements(invoice.immutable_snapshot->'tax_breakdown'->'entries') e
      WHERE (e->>'rate_percent')::numeric=rate;
    SELECT COALESCE(sum((e->>'tax_amount')::numeric),0) INTO prior_amount
      FROM public.paiement_allocations a JOIN public.paiement p ON p.id=a.paiement_id,
        LATERAL jsonb_array_elements(a.advance_vat_snapshot->'entries') e
      WHERE a.facture_id=invoice.id AND p.status NOT IN('REJECTED','REVERSED') AND p.workflow_status<>'REVERSED' AND p.reversal_of_id IS NULL
        AND (e->>'tax_rate')::numeric=rate;
    SELECT COALESCE(sum((e->>'pending_tax')::numeric),0) INTO credit_rate_pending FROM public.avoir credit,
      LATERAL jsonb_array_elements(credit.immutable_snapshot->'advance_credit_vat'->'entries') e
      WHERE credit.facture_id=invoice.id AND credit.statut IN('ISSUED','emis','emise','envoyee') AND (e->>'tax_rate')::numeric=rate;
    IF rate IS NULL OR amount IS NULL OR rate<0 OR rate>100 OR amount<0 OR amount<>round(amount,2)
      OR original_amount IS NULL OR prior_amount+amount+credit_rate_pending>original_amount THEN
      RAISE EXCEPTION 'ADVANCE-VAT-1268 original VAT category budget exceeded' USING ERRCODE='23514';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
COMMIT;
