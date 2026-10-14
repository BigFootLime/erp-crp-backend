-- Owner-only regression in the disposable database. All fixtures are rolled back.
BEGIN;
DO $$ BEGIN IF current_database()!~'^cerp_qualify_1268_[0-9]{14}$' THEN RAISE EXCEPTION 'disposable database required'; END IF;END $$;
INSERT INTO public.facture(id,numero,client_id,statut,total_ht,total_tax,total_ttc,currency,date_emission)
 SELECT 1268611,'QUAL-PAID-CREDIT-ROOT',client_id,'DRAFT',100,20,120,'EUR','2026-09-22' FROM public.clients ORDER BY client_id LIMIT 1;
UPDATE public.facture SET statut='ISSUED',document_status='ISSUED',legal_number='QUAL-NO-LEGAL-SEQUENCE',issued_at=now(),issued_by=7,
 immutable_snapshot='{"synthetic_storage_fixture":true,"invoice_type_code":380}',document_checksum_sha256=repeat('a',64),row_version=2 WHERE id=1268611;
INSERT INTO public.paiement(id,client_id,facture_id,montant,status,workflow_status,currency)
 SELECT 1268611,client_id,1268611,120,'ALLOCATED','ALLOCATED','EUR' FROM public.facture WHERE id=1268611;
INSERT INTO public.avoir(id,numero,client_id,facture_id,statut,total_ht,total_tax,total_ttc,currency)
 SELECT 1268611,'QUAL-CREDIT-ROOT',client_id,1268611,'DRAFT',50,10,60,'EUR' FROM public.facture WHERE id=1268611;
INSERT INTO public.avoir_source_allocations(id,avoir_id,facture_id,source_type,source_id,source_line_id,quantity_selected,amount_ttc,created_by)
 VALUES('12686110-0000-4000-8000-000000000001',1268611,1268611,'INVOICE_LINE','1268611','synthetic',1,60,7);
SAVEPOINT old_paid_credit_guard;
DO $$ DECLARE definition text;refused boolean:=false;BEGIN
 SELECT prior_allocation_function INTO definition FROM public.finance_refund_migration_state_1268 WHERE id=true;
 EXECUTE definition;
 BEGIN
  UPDATE public.avoir_source_allocations SET allocation_status='CONSUMED',quantity_credited=quantity_selected WHERE avoir_id=1268611;
 EXCEPTION WHEN check_violation THEN
  IF position('payment and credit allocations exceed' IN SQLERRM)=0 THEN RAISE;END IF;refused:=true;
 END;
 IF NOT refused THEN RAISE EXCEPTION 'old paid credit guard did not reproduce';END IF;
 RAISE NOTICE 'CUSTOMER-REFUND-1268 BEFORE_PAID_CREDIT_REFUSED';
END $$;
ROLLBACK TO SAVEPOINT old_paid_credit_guard;
RELEASE SAVEPOINT old_paid_credit_guard;
UPDATE public.avoir_source_allocations SET allocation_status='CONSUMED',quantity_credited=quantity_selected WHERE avoir_id=1268611;
SET CONSTRAINTS ALL IMMEDIATE;
DO $$ BEGIN
 IF public.fn_invoice_credit_total_1268(1268611)<>60 OR public.fn_invoice_cash_total_1268(1268611)<>120 THEN RAISE EXCEPTION 'paid credit balances incorrect';END IF;
 RAISE NOTICE 'CUSTOMER-REFUND-1268 AFTER_PAID_CREDIT_ALLOWED';
END $$;
ROLLBACK;
