-- #1268: immutable VAT cash effects on advance allocations; no historical backfill.
BEGIN;
ALTER TABLE public.paiement_allocations ADD COLUMN IF NOT EXISTS advance_vat_snapshot jsonb NULL;
ALTER TABLE public.accounting_export_batches ADD COLUMN IF NOT EXISTS only_unexported boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.fn_advance_cash_vat_1268()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  invoice public.facture%ROWTYPE; payment public.paiement%ROWTYPE; snapshot jsonb;
  prior_cash numeric; prior_tax numeric; total_tax numeric; total_effect numeric;
  rate numeric; amount numeric; original_amount numeric; prior_amount numeric; item jsonb;
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
    OR jsonb_typeof(snapshot) IS DISTINCT FROM 'object' OR snapshot->>'version' IS DISTINCT FROM '1'
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
    OR EXISTS(SELECT 1 FROM public.avoir WHERE facture_id=invoice.id AND statut IN('ISSUED','emis','emise','envoyee')) THEN
    RAISE EXCEPTION 'ADVANCE-VAT-1268 prior cash or credit evidence requires qualification' USING ERRCODE='23514';
  END IF;
  SELECT COALESCE(sum(a.amount_ttc),0),COALESCE(sum((a.advance_vat_snapshot->>'tax_after')::numeric-(a.advance_vat_snapshot->>'tax_before')::numeric),0)
    INTO prior_cash,prior_tax FROM public.paiement_allocations a JOIN public.paiement p ON p.id=a.paiement_id
    WHERE a.facture_id=invoice.id AND p.status NOT IN('REJECTED','REVERSED') AND p.workflow_status<>'REVERSED' AND p.reversal_of_id IS NULL;
  total_tax:=COALESCE(invoice.total_tax,invoice.total_ttc-invoice.total_ht);
  SELECT COALESCE(sum((e->>'tax_amount')::numeric),0) INTO total_effect FROM jsonb_array_elements(snapshot->'entries') e;
  IF invoice.total_ttc<=0 OR prior_cash+NEW.amount_ttc>invoice.total_ttc
    OR (snapshot->>'cash_before')::numeric IS DISTINCT FROM prior_cash
    OR (snapshot->>'cash_after')::numeric IS DISTINCT FROM prior_cash+NEW.amount_ttc
    OR (snapshot->>'tax_before')::numeric IS DISTINCT FROM prior_tax
    OR prior_tax<>round(total_tax*prior_cash/invoice.total_ttc,2)
    OR (snapshot->>'tax_after')::numeric IS DISTINCT FROM round(total_tax*(prior_cash+NEW.amount_ttc)/invoice.total_ttc,2)
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
    IF rate IS NULL OR amount IS NULL OR rate<0 OR rate>100 OR amount<0 OR amount<>round(amount,2)
      OR original_amount IS NULL OR prior_amount+amount>original_amount THEN
      RAISE EXCEPTION 'ADVANCE-VAT-1268 original VAT category budget exceeded' USING ERRCODE='23514';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_advance_cash_vat_1268 ON public.paiement_allocations;
CREATE TRIGGER trg_advance_cash_vat_1268 BEFORE INSERT OR UPDATE OR DELETE ON public.paiement_allocations
  FOR EACH ROW EXECUTE FUNCTION public.fn_advance_cash_vat_1268();

ALTER TABLE public.accounting_export_batches DROP CONSTRAINT IF EXISTS accounting_batch_sources_677_ck;
ALTER TABLE public.accounting_export_batches DROP CONSTRAINT IF EXISTS accounting_batch_sources_1268_ck;
ALTER TABLE public.accounting_export_batches ADD CONSTRAINT accounting_batch_sources_1268_ck CHECK (
  cardinality(source_types) BETWEEN 1 AND 6
  AND source_types <@ ARRAY['INVOICE','CREDIT_NOTE','PAYMENT','SUPPLIER_INVOICE','SUPPLIER_CREDIT_NOTE','ADVANCE_VAT']::text[]);
ALTER TABLE public.accounting_export_batch_sources DROP CONSTRAINT IF EXISTS accounting_batch_source_type_677_ck;
ALTER TABLE public.accounting_export_batch_sources DROP CONSTRAINT IF EXISTS accounting_batch_source_type_1268_ck;
ALTER TABLE public.accounting_export_batch_sources ADD CONSTRAINT accounting_batch_source_type_1268_ck CHECK (
  source_type IN('INVOICE','CREDIT_NOTE','PAYMENT','SUPPLIER_INVOICE','SUPPLIER_CREDIT_NOTE','ADVANCE_VAT'));
ALTER TABLE public.accounting_export_entries DROP CONSTRAINT IF EXISTS accounting_entry_source_type_677_ck;
ALTER TABLE public.accounting_export_entries DROP CONSTRAINT IF EXISTS accounting_entry_source_type_1268_ck;
ALTER TABLE public.accounting_export_entries ADD CONSTRAINT accounting_entry_source_type_1268_ck CHECK (
  source_type IN('INVOICE','CREDIT_NOTE','PAYMENT','SUPPLIER_INVOICE','SUPPLIER_CREDIT_NOTE','ADVANCE_VAT'));
ALTER TABLE public.accounting_export_source_claims DROP CONSTRAINT IF EXISTS accounting_claim_source_type_677_ck;
ALTER TABLE public.accounting_export_source_claims DROP CONSTRAINT IF EXISTS accounting_claim_source_type_1268_ck;
ALTER TABLE public.accounting_export_source_claims ADD CONSTRAINT accounting_claim_source_type_1268_ck CHECK (
  source_type IN('INVOICE','CREDIT_NOTE','PAYMENT','SUPPLIER_INVOICE','SUPPLIER_CREDIT_NOTE','ADVANCE_VAT'));
COMMENT ON COLUMN public.paiement_allocations.advance_vat_snapshot IS '#1268 frozen advance cash VAT; existing rows stay unqualified, no invented receipt.';
COMMIT;
