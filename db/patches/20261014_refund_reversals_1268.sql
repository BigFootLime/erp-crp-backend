-- #1268: append an exact correction instead of deleting recorded bank evidence.
BEGIN;
SET LOCAL lock_timeout='5s';
CREATE SEQUENCE IF NOT EXISTS public.customer_refund_reversal_number_seq;
CREATE TABLE IF NOT EXISTS public.customer_refund_reversals (
 id uuid PRIMARY KEY,code text NOT NULL UNIQUE,refund_id uuid NOT NULL UNIQUE REFERENCES public.customer_refunds(id),
 facture_id bigint NOT NULL REFERENCES public.facture(id),avoir_id bigint NOT NULL REFERENCES public.avoir(id),
 client_id varchar(120) NOT NULL,currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
 amount_ttc numeric(18,2) NOT NULL CHECK(amount_ttc>0),value_date date NOT NULL,
 booking_date date NOT NULL CHECK(booking_date>=value_date),mode text NOT NULL,
 reference text NOT NULL CHECK(length(btrim(reference)) BETWEEN 1 AND 200),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 8 AND 2000),proof_document_id uuid NULL,
 source_snapshot jsonb NOT NULL CHECK(jsonb_typeof(source_snapshot)='object'),
 created_at timestamptz NOT NULL DEFAULT now(),created_by integer NOT NULL REFERENCES public.users(id),correlation_id uuid NOT NULL
);
CREATE INDEX IF NOT EXISTS customer_refund_reversals_invoice_1268_idx ON public.customer_refund_reversals(facture_id,avoir_id);

CREATE OR REPLACE VIEW public.customer_refunds_effective_1268 AS
 SELECT refund.* FROM public.customer_refunds refund
 WHERE NOT EXISTS(SELECT 1 FROM public.customer_refund_reversals reversal WHERE reversal.refund_id=refund.id);
CREATE OR REPLACE VIEW public.customer_refund_sources_effective_1268 AS
 SELECT source.* FROM public.customer_refund_sources source
 JOIN public.customer_refunds_effective_1268 refund ON refund.id=source.refund_id;
GRANT SELECT,INSERT ON public.customer_refund_reversals TO cerp_app;
GRANT SELECT ON public.customer_refunds_effective_1268,public.customer_refund_sources_effective_1268 TO cerp_app;
GRANT USAGE,SELECT ON SEQUENCE public.customer_refund_reversal_number_seq TO cerp_app;

CREATE OR REPLACE FUNCTION public.fn_customer_refund_reversal_write_1268()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE original public.customer_refunds%ROWTYPE;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'REFUND-REVERSAL-1268 immutable correction evidence' USING ERRCODE='55000'; END IF;
 PERFORM public.fn_lock_delivery_prepayment_write_1268();
 SELECT * INTO original FROM public.customer_refunds WHERE id=NEW.refund_id;
 IF original.id IS NULL OR NEW.facture_id IS DISTINCT FROM original.facture_id OR NEW.avoir_id IS DISTINCT FROM original.avoir_id
  OR NEW.client_id IS DISTINCT FROM original.client_id OR NEW.currency IS DISTINCT FROM original.currency
  OR NEW.amount_ttc IS DISTINCT FROM original.amount_ttc OR NEW.mode IS DISTINCT FROM original.mode
  OR NEW.value_date<original.value_date
  OR NEW.source_snapshot->>'refund_id' IS DISTINCT FROM original.id::text
  OR (NEW.source_snapshot->>'amount')::numeric IS DISTINCT FROM original.amount_ttc
 THEN RAISE EXCEPTION 'REFUND-REVERSAL-1268 exact original refund and date required' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_customer_refund_reversal_write_1268 ON public.customer_refund_reversals;
CREATE TRIGGER trg_customer_refund_reversal_write_1268 BEFORE INSERT OR UPDATE OR DELETE ON public.customer_refund_reversals
 FOR EACH ROW EXECUTE FUNCTION public.fn_customer_refund_reversal_write_1268();
DROP TRIGGER IF EXISTS trg_delivery_prepayment_epoch_1268 ON public.customer_refund_reversals;
CREATE TRIGGER trg_delivery_prepayment_epoch_1268 BEFORE INSERT OR UPDATE OR DELETE ON public.customer_refund_reversals
 FOR EACH STATEMENT EXECUTE FUNCTION public.fn_touch_delivery_prepayment_1268();

-- Keep complete original function definitions for an evidence-refusing rollback.
CREATE TABLE IF NOT EXISTS public.finance_refund_reversal_migration_state_1268 (
 signature text PRIMARY KEY,definition text NOT NULL
);
REVOKE ALL ON public.finance_refund_reversal_migration_state_1268 FROM cerp_app;
DO $$ DECLARE signature text;definition text;needle text;BEGIN
 FOREACH signature IN ARRAY ARRAY[
  'public.fn_customer_refund_write_1268()','public.fn_check_customer_refunds_1268()',
  'public.fn_validate_facturation_allocation_227()','public.fn_check_final_prepayments_1268()',
  'public.fn_advance_cash_vat_1268()'
 ] LOOP
  definition:=pg_get_functiondef(signature::regprocedure);
  INSERT INTO public.finance_refund_reversal_migration_state_1268 VALUES(signature,definition) ON CONFLICT DO NOTHING;
  -- Exact complete headers/sources remain stored. Effective economic readers
  -- exclude a compensated refund, including its original payment budgets.
  definition:=replace(definition,'FROM public.customer_refund_sources ','FROM public.customer_refund_sources_effective_1268 ');
  definition:=replace(definition,'FROM public.customer_refunds ','FROM public.customer_refunds_effective_1268 ');
  IF signature='public.fn_check_customer_refunds_1268()' AND position('''customer_refund_reversals''' IN definition)=0 THEN
   needle:='IN(''avoir'',''avoir_source_allocations'',''paiement_allocations'',''customer_refunds'')';
   IF position(needle IN definition)=0 THEN RAISE EXCEPTION 'REFUND-REVERSAL-1268 canonical settlement function differs'; END IF;
   definition:=replace(definition,needle,'IN(''avoir'',''avoir_source_allocations'',''paiement_allocations'',''customer_refunds'',''customer_refund_reversals'')');
  END IF;
  EXECUTE definition;
 END LOOP;
END $$;
DROP TRIGGER IF EXISTS trg_check_customer_refunds_1268 ON public.customer_refund_reversals;
CREATE CONSTRAINT TRIGGER trg_check_customer_refunds_1268 AFTER INSERT OR UPDATE OR DELETE ON public.customer_refund_reversals
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.fn_check_customer_refunds_1268();

-- A retained refund posting is the authority for its inverse, even when the
-- cabinet subsequently changes the mapping. Serialize release and correction.
CREATE OR REPLACE FUNCTION public.fn_lock_refund_accounting_1268()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN PERFORM public.fn_lock_delivery_prepayment_write_1268(); RETURN NULL; END $$;
CREATE OR REPLACE FUNCTION public.fn_retain_refund_accounting_1268()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_TABLE_NAME='accounting_export_batches' THEN
  IF OLD.status='GENERATED' AND NEW.status IS DISTINCT FROM OLD.status AND EXISTS(
   SELECT 1 FROM public.accounting_export_source_claims claim
   JOIN public.customer_refund_reversals reversal ON reversal.refund_id::text=claim.source_id
   WHERE claim.batch_id=OLD.id AND claim.source_type='CUSTOMER_REFUND' AND claim.released_at IS NULL
  ) THEN RAISE EXCEPTION 'REFUND-REVERSAL-1268 original accounting export must remain available' USING ERRCODE='23514'; END IF;
 ELSE
  IF OLD.source_type='CUSTOMER_REFUND' AND OLD.released_at IS NULL AND EXISTS(
   SELECT 1 FROM public.customer_refund_reversals WHERE refund_id::text=OLD.source_id
  ) AND EXISTS(SELECT 1 FROM public.accounting_export_batches WHERE id=OLD.batch_id AND status='GENERATED')
   AND (TG_OP='DELETE' OR NEW IS DISTINCT FROM OLD)
  THEN RAISE EXCEPTION 'REFUND-REVERSAL-1268 original accounting claim must remain available' USING ERRCODE='23514'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_lock_refund_accounting_1268 ON public.accounting_export_source_claims;
CREATE TRIGGER trg_lock_refund_accounting_1268 BEFORE INSERT OR UPDATE OR DELETE ON public.accounting_export_source_claims
 FOR EACH STATEMENT EXECUTE FUNCTION public.fn_lock_refund_accounting_1268();
DROP TRIGGER IF EXISTS trg_lock_refund_accounting_1268 ON public.accounting_export_batches;
CREATE TRIGGER trg_lock_refund_accounting_1268 BEFORE UPDATE ON public.accounting_export_batches
 FOR EACH STATEMENT EXECUTE FUNCTION public.fn_lock_refund_accounting_1268();
DROP TRIGGER IF EXISTS trg_retain_refund_accounting_1268 ON public.accounting_export_source_claims;
CREATE TRIGGER trg_retain_refund_accounting_1268 BEFORE UPDATE OR DELETE ON public.accounting_export_source_claims
 FOR EACH ROW EXECUTE FUNCTION public.fn_retain_refund_accounting_1268();
DROP TRIGGER IF EXISTS trg_retain_refund_accounting_1268 ON public.accounting_export_batches;
CREATE TRIGGER trg_retain_refund_accounting_1268 BEFORE UPDATE ON public.accounting_export_batches
 FOR EACH ROW EXECUTE FUNCTION public.fn_retain_refund_accounting_1268();

ALTER TABLE public.accounting_export_batch_sources DROP CONSTRAINT accounting_batch_source_type_1268_ck;
ALTER TABLE public.accounting_export_batch_sources ADD CONSTRAINT accounting_batch_source_type_1268_ck
 CHECK(source_type IN('INVOICE','CREDIT_NOTE','PAYMENT','SUPPLIER_INVOICE','SUPPLIER_CREDIT_NOTE','ADVANCE_VAT','CUSTOMER_REFUND','CUSTOMER_REFUND_REVERSAL'));
ALTER TABLE public.accounting_export_entries DROP CONSTRAINT accounting_entry_source_type_1268_ck;
ALTER TABLE public.accounting_export_entries ADD CONSTRAINT accounting_entry_source_type_1268_ck
 CHECK(source_type IN('INVOICE','CREDIT_NOTE','PAYMENT','SUPPLIER_INVOICE','SUPPLIER_CREDIT_NOTE','ADVANCE_VAT','CUSTOMER_REFUND','CUSTOMER_REFUND_REVERSAL'));
ALTER TABLE public.accounting_export_source_claims DROP CONSTRAINT accounting_claim_source_type_1268_ck;
ALTER TABLE public.accounting_export_source_claims ADD CONSTRAINT accounting_claim_source_type_1268_ck
 CHECK(source_type IN('INVOICE','CREDIT_NOTE','PAYMENT','SUPPLIER_INVOICE','SUPPLIER_CREDIT_NOTE','ADVANCE_VAT','CUSTOMER_REFUND','CUSTOMER_REFUND_REVERSAL'));
ALTER TABLE public.accounting_export_batches DROP CONSTRAINT accounting_batch_sources_1268_ck;
ALTER TABLE public.accounting_export_batches ADD CONSTRAINT accounting_batch_sources_1268_ck CHECK(cardinality(source_types) BETWEEN 1 AND 8
 AND source_types <@ ARRAY['INVOICE','CREDIT_NOTE','PAYMENT','SUPPLIER_INVOICE','SUPPLIER_CREDIT_NOTE','ADVANCE_VAT','CUSTOMER_REFUND','CUSTOMER_REFUND_REVERSAL']::text[]);
COMMIT;
