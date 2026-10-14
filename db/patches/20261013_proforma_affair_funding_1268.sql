-- #1268: physical customer, billed companies and cash evidence stay distinct.
-- No existing affair is implicitly migrated to "not prepaid".
CREATE SEQUENCE IF NOT EXISTS public.proforma_client_reference_seq;

-- Advisory locks alone do not refresh a SERIALIZABLE snapshot after waiting.
-- A locked epoch row makes an old BL snapshot fail with 40001, rather than
-- shipping against cash evidence reversed while it was waiting for Finance.
CREATE TABLE IF NOT EXISTS public.delivery_prepayment_epoch_1268 (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  version bigint NOT NULL DEFAULT 0 CHECK (version>=0),
  writer_transaction bigint NOT NULL DEFAULT 0
);
INSERT INTO public.delivery_prepayment_epoch_1268(singleton) VALUES(true) ON CONFLICT DO NOTHING;
CREATE OR REPLACE FUNCTION public.fn_lock_delivery_prepayment_write_1268()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('delivery-prepayment-binding',0));
  UPDATE public.delivery_prepayment_epoch_1268 SET version=version+1,writer_transaction=txid_current()
    WHERE singleton AND writer_transaction<>txid_current();
END;
$$;
CREATE OR REPLACE FUNCTION public.fn_lock_delivery_prepayment_read_1268()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('delivery-prepayment-binding',0));
  PERFORM version FROM public.delivery_prepayment_epoch_1268 WHERE singleton FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'prepayment epoch missing' USING ERRCODE='55000'; END IF;
END;
$$;
CREATE OR REPLACE FUNCTION public.fn_touch_delivery_prepayment_1268()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM public.fn_lock_delivery_prepayment_write_1268();
  RETURN NULL;
END;
$$;
-- Statement triggers run before any modified row. All retained fiscal and cash
-- writers participate, including legacy payment reversal/credit-note paths.
DO $$ DECLARE guarded_table text; BEGIN
  FOREACH guarded_table IN ARRAY ARRAY['paiement','paiement_allocations','facture','facture_source_allocations','avoir','avoir_source_allocations'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_delivery_prepayment_epoch_1268 ON public.%I',guarded_table);
    EXECUTE format('CREATE TRIGGER trg_delivery_prepayment_epoch_1268 BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.fn_touch_delivery_prepayment_1268()',guarded_table);
  END LOOP;
END $$;
REVOKE ALL ON public.delivery_prepayment_epoch_1268 FROM PUBLIC,cerp_app;
GRANT SELECT ON public.delivery_prepayment_epoch_1268 TO cerp_app;
REVOKE ALL ON FUNCTION public.fn_lock_delivery_prepayment_write_1268(),public.fn_lock_delivery_prepayment_read_1268(),public.fn_touch_delivery_prepayment_1268() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_lock_delivery_prepayment_write_1268(),public.fn_lock_delivery_prepayment_read_1268() TO cerp_app;

-- Existing commercial prices have the same EUR basis as Finance #227.
ALTER TABLE public.commande_client ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'EUR';
-- Null is deliberately retained on historical orders. Only a new order or an
-- explicit reviewed affair decision establishes its prepayment requirement.
ALTER TABLE public.commande_client ADD COLUMN IF NOT EXISTS delivery_prepayment_requirement text NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.commande_client'::regclass AND conname='commande_currency_1268_ck') THEN
    ALTER TABLE public.commande_client ADD CONSTRAINT commande_currency_1268_ck CHECK (currency ~ '^[A-Z]{3}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.commande_client'::regclass AND conname='commande_prepayment_requirement_1268_ck') THEN
    ALTER TABLE public.commande_client ADD CONSTRAINT commande_prepayment_requirement_1268_ck CHECK (delivery_prepayment_requirement IN ('NOT_REQUIRED','PROFORMA'));
  END IF;
END $$;

ALTER TABLE public.finance_command_receipts DROP CONSTRAINT IF EXISTS finance_command_receipts_aggregate_type_check;
ALTER TABLE public.finance_command_receipts ADD CONSTRAINT finance_command_receipts_aggregate_type_check
  CHECK (aggregate_type IN ('FACTURE','AVOIR','PAIEMENT','PROFORMA'));
ALTER TABLE public.finance_event_log DROP CONSTRAINT IF EXISTS finance_event_log_aggregate_type_check;
ALTER TABLE public.finance_event_log ADD CONSTRAINT finance_event_log_aggregate_type_check
  CHECK (aggregate_type IN ('FACTURE','AVOIR','PAIEMENT','PROFORMA'));

CREATE TABLE IF NOT EXISTS public.proforma_client (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference text NOT NULL UNIQUE,
  client_id text NOT NULL REFERENCES public.clients(client_id) ON DELETE RESTRICT,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ISSUED','CANCELLED')),
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  preview_hash text NULL CHECK (preview_hash IS NULL OR preview_hash ~ '^[a-f0-9]{64}$'),
  preview_payload jsonb NOT NULL CHECK (jsonb_typeof(preview_payload)='object'),
  issued_snapshot jsonb NULL,
  issued_at timestamptz NULL,
  issued_by integer NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  cancelled_at timestamptz NULL,
  cancelled_by integer NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  cancellation_reason text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  correlation_id uuid NOT NULL,
  CONSTRAINT proforma_issued_evidence_1268_ck CHECK (status<>'ISSUED' OR
    (issued_snapshot IS NOT NULL AND jsonb_typeof(issued_snapshot)='object'
      AND preview_hash IS NOT NULL AND issued_at IS NOT NULL AND issued_by IS NOT NULL)),
  CONSTRAINT proforma_cancel_evidence_1268_ck CHECK (status<>'CANCELLED' OR
    (cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL AND length(trim(cancellation_reason))>=3))
);

-- Private commercial documents have their own real Finance parent. Never link
-- a proforma to a fictitious invoice or inherit CRM access through the recipient.
INSERT INTO public.ged_entity_types(entity_type,label,module_key,target_table,target_pk_column,sort_order,is_active)
  VALUES('PROFORMA','Proforma','facturation','proforma_client','id',127,true) ON CONFLICT(entity_type) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.delivery_affair_billing_shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  allocation_id bigint NOT NULL REFERENCES public.commande_ligne_affaire_allocation(id) ON DELETE RESTRICT,
  billed_client_id text NOT NULL REFERENCES public.clients(client_id) ON DELETE RESTRICT,
  quantity numeric(18,3) NOT NULL CHECK (quantity > 0),
  plan_version integer NOT NULL DEFAULT 1 CHECK (plan_version > 0),
  active boolean NOT NULL DEFAULT true,
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  correlation_id uuid NOT NULL,
  UNIQUE (allocation_id,plan_version,billed_client_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS billing_share_current_1268_uq ON public.delivery_affair_billing_shares(allocation_id,billed_client_id) WHERE active;

CREATE TABLE IF NOT EXISTS public.proforma_affair_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proforma_id uuid NOT NULL REFERENCES public.proforma_client(id) ON DELETE RESTRICT,
  allocation_id bigint NOT NULL REFERENCES public.commande_ligne_affaire_allocation(id) ON DELETE RESTRICT,
  quantity numeric(18,3) NOT NULL CHECK (quantity > 0),
  source_revision text NOT NULL CHECK (source_revision ~ '^[a-f0-9]{64}$'),
  source_snapshot jsonb NOT NULL CHECK (jsonb_typeof(source_snapshot)='object'),
  UNIQUE (proforma_id,allocation_id)
);

CREATE TABLE IF NOT EXISTS public.proforma_billing_parts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proforma_line_id uuid NOT NULL REFERENCES public.proforma_affair_lines(id) ON DELETE RESTRICT,
  billing_share_id uuid NOT NULL REFERENCES public.delivery_affair_billing_shares(id) ON DELETE RESTRICT,
  billed_client_id text NOT NULL REFERENCES public.clients(client_id) ON DELETE RESTRICT,
  quantity numeric(18,3) NOT NULL CHECK (quantity > 0),
  unit_price_ex_tax numeric(18,4) NOT NULL CHECK (unit_price_ex_tax >= 0),
  discount_percent numeric(8,4) NOT NULL CHECK (discount_percent BETWEEN 0 AND 100),
  global_discount_percent numeric(8,4) NOT NULL CHECK (global_discount_percent BETWEEN 0 AND 100),
  tax_rate_percent numeric(8,4) NOT NULL CHECK (tax_rate_percent BETWEEN 0 AND 100),
  total_ex_tax numeric(18,2) NOT NULL CHECK (total_ex_tax >= 0),
  tax_amount numeric(18,2) NOT NULL CHECK (tax_amount >= 0),
  total_incl_tax numeric(18,2) NOT NULL CHECK (total_incl_tax = total_ex_tax + tax_amount),
  billed_client_snapshot jsonb NOT NULL CHECK (jsonb_typeof(billed_client_snapshot)='object'),
  UNIQUE (proforma_line_id,billed_client_id)
);

CREATE TABLE IF NOT EXISTS public.delivery_affair_prepayment_terms (
  allocation_id bigint PRIMARY KEY REFERENCES public.commande_ligne_affaire_allocation(id) ON DELETE RESTRICT,
  requirement text NOT NULL CHECK (requirement IN ('NOT_REQUIRED','PROFORMA','UNCONFIRMED')),
  proforma_line_id uuid NULL REFERENCES public.proforma_affair_lines(id) ON DELETE RESTRICT,
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  decision_reason text NOT NULL CHECK (length(trim(decision_reason)) >= 3),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  correlation_id uuid NOT NULL,
  CHECK (requirement='PROFORMA' OR proforma_line_id IS NULL)
);

-- These identify real Finance DEPOSIT sources; no fiscal number is allocated
-- when a proforma is drafted or issued. Finance issues the actual advance.
CREATE TABLE IF NOT EXISTS public.proforma_deposit_sources (
  facture_source_allocation_id uuid PRIMARY KEY REFERENCES public.facture_source_allocations(id) ON DELETE RESTRICT,
  proforma_billing_part_id uuid NOT NULL REFERENCES public.proforma_billing_parts(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  correlation_id uuid NOT NULL
);

-- A final invoice can bill a company other than the physical BL recipient.
-- Its exact affair quantities are retained separately from monetary advances.
CREATE TABLE IF NOT EXISTS public.proforma_final_invoice_sources (
  facture_source_allocation_id uuid NOT NULL REFERENCES public.facture_source_allocations(id) ON DELETE RESTRICT,
  proforma_billing_part_id uuid NOT NULL REFERENCES public.proforma_billing_parts(id) ON DELETE RESTRICT,
  quantity numeric(18,3) NOT NULL CHECK (quantity>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  correlation_id uuid NOT NULL,
  PRIMARY KEY(facture_source_allocation_id,proforma_billing_part_id)
);
CREATE INDEX IF NOT EXISTS proforma_final_part_1268_idx ON public.proforma_final_invoice_sources(proforma_billing_part_id);

ALTER TABLE public.facture ADD COLUMN IF NOT EXISTS prepaid_amount_ttc numeric(18,2) NOT NULL DEFAULT 0;
ALTER TABLE public.facture ADD COLUMN IF NOT EXISTS amount_due_at_issue numeric(18,2) NULL;
ALTER TABLE public.facture_echeance ADD COLUMN IF NOT EXISTS amount_autofilled boolean NOT NULL DEFAULT false;
-- A fully prepaid final invoice has a genuine zero due date, never a fake cent.
ALTER TABLE public.facture_echeance DROP CONSTRAINT IF EXISTS facture_echeance_amount_due_check;
ALTER TABLE public.facture_echeance DROP CONSTRAINT IF EXISTS facture_echeance_nonnegative_due_1268_ck;
ALTER TABLE public.facture_echeance ADD CONSTRAINT facture_echeance_nonnegative_due_1268_ck CHECK(amount_due>=0);
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.facture'::regclass AND conname='facture_prepaid_amount_1268_ck') THEN
  ALTER TABLE public.facture ADD CONSTRAINT facture_prepaid_amount_1268_ck CHECK(prepaid_amount_ttc>=0 AND prepaid_amount_ttc<=total_ttc
    AND (amount_due_at_issue IS NULL OR (amount_due_at_issue>=0 AND amount_due_at_issue=total_ttc-prepaid_amount_ttc)));
 END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.proforma_receipt_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_allocation_id uuid NOT NULL REFERENCES public.paiement_allocations(id) ON DELETE RESTRICT,
  deposit_source_id uuid NOT NULL REFERENCES public.proforma_deposit_sources(facture_source_allocation_id) ON DELETE RESTRICT,
  amount_ttc numeric(18,2) NOT NULL CHECK (amount_ttc > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  correlation_id uuid NOT NULL
);
CREATE INDEX IF NOT EXISTS proforma_receipt_payment_1268_idx ON public.proforma_receipt_assignments(payment_allocation_id);
CREATE INDEX IF NOT EXISTS proforma_receipt_source_1268_idx ON public.proforma_receipt_assignments(deposit_source_id);

CREATE TABLE IF NOT EXISTS public.proforma_receipt_releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id uuid NOT NULL REFERENCES public.proforma_receipt_assignments(id) ON DELETE RESTRICT,
  amount_ttc numeric(18,2) NOT NULL CHECK (amount_ttc > 0),
  reason text NOT NULL CHECK (length(trim(reason)) >= 3),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  correlation_id uuid NOT NULL
);
CREATE INDEX IF NOT EXISTS proforma_release_assignment_1268_idx ON public.proforma_receipt_releases(assignment_id);

CREATE TABLE IF NOT EXISTS public.proforma_final_prepayments(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 final_source_allocation_id uuid NOT NULL REFERENCES public.facture_source_allocations(id) ON DELETE RESTRICT,
 proforma_billing_part_id uuid NOT NULL REFERENCES public.proforma_billing_parts(id) ON DELETE RESTRICT,
 receipt_assignment_id uuid NOT NULL REFERENCES public.proforma_receipt_assignments(id) ON DELETE RESTRICT,
 deposit_source_id uuid NOT NULL REFERENCES public.proforma_deposit_sources(facture_source_allocation_id) ON DELETE RESTRICT,
 amount_ex_tax numeric(18,2) NOT NULL CHECK(amount_ex_tax>=0),tax_amount numeric(18,2) NOT NULL CHECK(tax_amount>=0),
 amount_ttc numeric(18,2) NOT NULL CHECK(amount_ttc>0 AND amount_ttc=amount_ex_tax+tax_amount),
 created_at timestamptz NOT NULL DEFAULT now(),created_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 correlation_id uuid NOT NULL,
 UNIQUE(final_source_allocation_id,proforma_billing_part_id,receipt_assignment_id)
);
CREATE INDEX IF NOT EXISTS proforma_final_receipt_1268_idx ON public.proforma_final_prepayments(receipt_assignment_id);
CREATE INDEX IF NOT EXISTS proforma_final_deposit_1268_idx ON public.proforma_final_prepayments(deposit_source_id);

-- Same two-stage largest-remainder allocation as the preview: document gross
-- to invoice lines, then each line to its retained affair/company quantities.
CREATE OR REPLACE FUNCTION public.fn_final_prepayment_targets_1268(p_invoice_id bigint)
RETURNS TABLE(final_source_allocation_id uuid,proforma_billing_part_id uuid,amount_ttc numeric)
LANGUAGE sql STABLE AS $$
 WITH line_weights AS(
  SELECT line.id,line.total_ttc*100 AS weight,invoice.total_ttc*100 AS total,
    COALESCE(source.source_line_id,line.snapshot_json->>'source_line_id',line.id::text) AS tie_key,
    source.id AS source_id
  FROM public.facture_ligne line JOIN public.facture invoice ON invoice.id=line.facture_id
  LEFT JOIN public.facture_source_allocations source ON source.facture_ligne_id=line.id AND source.allocation_status IN('DRAFT','CONSUMED')
  WHERE line.facture_id=p_invoice_id
 ), line_floors AS(
  SELECT *,COALESCE(floor(total*weight/NULLIF(sum(weight) OVER(),0)),0) AS cents,
    COALESCE(mod(total*weight,NULLIF(sum(weight) OVER(),0)),0) AS remainder FROM line_weights
 ), line_budgets AS(
  SELECT *,cents+CASE WHEN row_number() OVER(ORDER BY remainder DESC,tie_key COLLATE "C")<=total-sum(cents) OVER() THEN 1 ELSE 0 END AS budget
  FROM line_floors
 ), part_weights AS(
  SELECT line.source_id,binding.proforma_billing_part_id,line.budget,binding.quantity*1000 AS weight,
    sum(binding.quantity*1000) OVER(PARTITION BY line.source_id) AS total_weight
  FROM line_budgets line JOIN public.proforma_final_invoice_sources binding ON binding.facture_source_allocation_id=line.source_id
 ), part_floors AS(
  SELECT *,floor(budget*weight/NULLIF(total_weight,0)) AS cents,mod(budget*weight,NULLIF(total_weight,0)) AS remainder FROM part_weights
 )
 SELECT source_id,proforma_billing_part_id,
  (cents+CASE WHEN row_number() OVER(PARTITION BY source_id ORDER BY remainder DESC,proforma_billing_part_id::text COLLATE "C")
    <=budget-sum(cents) OVER(PARTITION BY source_id) THEN 1 ELSE 0 END)/100
 FROM part_floors;
$$;

CREATE OR REPLACE FUNCTION public.fn_final_prepayment_budget_1268()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE valid_binding boolean; v_receipt_amount numeric; v_released numeric; v_used_receipt numeric;
 v_deposit_gross numeric; v_deposit_net numeric; v_used_gross numeric; v_used_net numeric; v_credits numeric;
 v_target numeric; v_used_target numeric; v_final_invoice bigint; expected_net numeric;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'final prepayment evidence is append only' USING ERRCODE='55000'; END IF;
 PERFORM public.fn_lock_delivery_prepayment_write_1268();
 SELECT final.source_type='DELIVERY_LINE' AND final.allocation_status='DRAFT' AND final_invoice.document_status='DRAFT'
   AND receipt.deposit_source_id=NEW.deposit_source_id AND deposit.source_type='DEPOSIT' AND deposit.allocation_status='CONSUMED'
   AND deposit_invoice.document_status='ISSUED' AND deposit_invoice.immutable_snapshot->>'invoice_type_code'='386'
   AND final_invoice.client_id=deposit_invoice.client_id AND final_invoice.client_id::text=part.billed_client_id
   AND payment.client_id=deposit_invoice.client_id AND payment.currency=deposit_invoice.currency
   AND final_invoice.currency=deposit_invoice.currency AND payment_allocation.facture_id=deposit_invoice.id
   AND payment.status IN('UNALLOCATED','PARTIALLY_ALLOCATED','ALLOCATED') AND payment.workflow_status IN('RECORDED','ALLOCATED')
   AND payment.reversal_of_id IS NULL,
   receipt.amount_ttc,deposit.amount_incl_tax,deposit.amount_ex_tax,final.facture_id
 INTO valid_binding,v_receipt_amount,v_deposit_gross,v_deposit_net,v_final_invoice
 FROM public.facture_source_allocations final JOIN public.facture final_invoice ON final_invoice.id=final.facture_id
 JOIN public.proforma_final_invoice_sources final_binding ON final_binding.facture_source_allocation_id=final.id AND final_binding.proforma_billing_part_id=NEW.proforma_billing_part_id
 JOIN public.proforma_receipt_assignments receipt ON receipt.id=NEW.receipt_assignment_id
 JOIN public.proforma_deposit_sources deposit_binding ON deposit_binding.facture_source_allocation_id=NEW.deposit_source_id AND deposit_binding.proforma_billing_part_id=NEW.proforma_billing_part_id
 JOIN public.proforma_billing_parts part ON part.id=NEW.proforma_billing_part_id
 JOIN public.facture_source_allocations deposit ON deposit.id=NEW.deposit_source_id
 JOIN public.facture deposit_invoice ON deposit_invoice.id=deposit.facture_id
 JOIN public.paiement_allocations payment_allocation ON payment_allocation.id=receipt.payment_allocation_id
 JOIN public.paiement payment ON payment.id=payment_allocation.paiement_id
 WHERE final.id=NEW.final_source_allocation_id FOR UPDATE OF final,final_invoice,part;
 IF NOT COALESCE(valid_binding,false) THEN RAISE EXCEPTION 'final prepayment requires same company/currency and genuine paid advance' USING ERRCODE='23514'; END IF;
 SELECT COALESCE(sum(amount_ttc),0) INTO v_released FROM public.proforma_receipt_releases WHERE assignment_id=NEW.receipt_assignment_id;
 SELECT COALESCE(sum(applied.amount_ttc),0) INTO v_used_receipt FROM public.proforma_final_prepayments applied
 JOIN public.facture_source_allocations final ON final.id=applied.final_source_allocation_id
 WHERE applied.receipt_assignment_id=NEW.receipt_assignment_id AND final.allocation_status IN('DRAFT','CONSUMED');
 SELECT COALESCE(sum(applied.amount_ttc),0),COALESCE(sum(applied.amount_ex_tax),0) INTO v_used_gross,v_used_net
 FROM public.proforma_final_prepayments applied JOIN public.facture_source_allocations final ON final.id=applied.final_source_allocation_id
 WHERE applied.deposit_source_id=NEW.deposit_source_id AND final.allocation_status IN('DRAFT','CONSUMED');
 SELECT COALESCE(sum(credit.amount_ttc),0) INTO v_credits FROM public.avoir_source_allocations credit
 JOIN public.facture_source_allocations deposit ON deposit.facture_id=credit.facture_id AND deposit.facture_ligne_id=credit.facture_ligne_id
 WHERE deposit.id=NEW.deposit_source_id AND credit.allocation_status='CONSUMED';
 SELECT amount_ttc INTO v_target FROM public.fn_final_prepayment_targets_1268(v_final_invoice)
 WHERE final_source_allocation_id=NEW.final_source_allocation_id AND proforma_billing_part_id=NEW.proforma_billing_part_id;
 SELECT COALESCE(sum(amount_ttc),0) INTO v_used_target FROM public.proforma_final_prepayments
 WHERE final_source_allocation_id=NEW.final_source_allocation_id AND proforma_billing_part_id=NEW.proforma_billing_part_id;
 expected_net:=round((v_used_gross+NEW.amount_ttc)*v_deposit_net/v_deposit_gross,2)-v_used_net;
 IF v_target IS NULL OR v_used_target+NEW.amount_ttc>v_target OR v_used_receipt+NEW.amount_ttc>v_receipt_amount-v_released
   OR v_used_gross+NEW.amount_ttc>v_deposit_gross-v_credits OR NEW.amount_ex_tax<>expected_net THEN
  RAISE EXCEPTION 'final prepayment exceeds unused cash, deposit or delivered value' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_final_prepayment_budget_1268 ON public.proforma_final_prepayments;
CREATE TRIGGER trg_final_prepayment_budget_1268 BEFORE INSERT OR UPDATE OR DELETE ON public.proforma_final_prepayments
 FOR EACH ROW EXECUTE FUNCTION public.fn_final_prepayment_budget_1268();
GRANT SELECT,INSERT ON public.proforma_final_prepayments TO cerp_app;
REVOKE UPDATE,DELETE,TRUNCATE ON public.proforma_final_prepayments FROM cerp_app;
GRANT EXECUTE ON FUNCTION public.fn_final_prepayment_targets_1268(bigint) TO cerp_app;

CREATE OR REPLACE FUNCTION public.fn_proforma_receipt_budget_1268()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_payment_allocation_id uuid; v_deposit_source_id uuid; parent_amount numeric(18,2);
  source_amount numeric(18,2); used_amount numeric(18,2); binding_valid boolean;
  assignment_amount numeric(18,2);
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'proforma receipt evidence is append only' USING ERRCODE='55000';
  END IF;
  -- BL mutations retain the shared lock. Binding/receipt changes use its
  -- exclusive form before parent locks, including the repository command.
  PERFORM public.fn_lock_delivery_prepayment_write_1268();
  IF TG_TABLE_NAME='proforma_receipt_releases' THEN
    SELECT payment_allocation_id,deposit_source_id INTO v_payment_allocation_id,v_deposit_source_id
      FROM public.proforma_receipt_assignments WHERE id=NEW.assignment_id;
  ELSE
    v_payment_allocation_id:=NEW.payment_allocation_id; v_deposit_source_id:=NEW.deposit_source_id;
  END IF;
  SELECT amount_ttc INTO parent_amount FROM public.paiement_allocations WHERE id=v_payment_allocation_id FOR UPDATE;
  SELECT source.amount_incl_tax, source.source_type='DEPOSIT'
    AND source.allocation_status='CONSUMED' AND invoice.document_status='ISSUED'
    AND invoice.client_id::text=part.billed_client_id AND invoice.currency=proforma.currency
    AND payment.client_id::text=part.billed_client_id AND payment.currency=proforma.currency
    AND payment.status IN ('UNALLOCATED','PARTIALLY_ALLOCATED','ALLOCATED')
    AND payment.workflow_status IN ('RECORDED','ALLOCATED')
    AND payment.reversal_of_id IS NULL AND allocation.facture_id=source.facture_id
    AND proforma.status='ISSUED'
    INTO source_amount,binding_valid
    FROM public.proforma_deposit_sources binding
    JOIN public.facture_source_allocations source ON source.id=binding.facture_source_allocation_id
    JOIN public.facture invoice ON invoice.id=source.facture_id
    JOIN public.proforma_billing_parts part ON part.id=binding.proforma_billing_part_id
    JOIN public.proforma_affair_lines line ON line.id=part.proforma_line_id
    JOIN public.proforma_client proforma ON proforma.id=line.proforma_id
    JOIN public.paiement_allocations allocation ON allocation.id=v_payment_allocation_id
    JOIN public.paiement payment ON payment.id=allocation.paiement_id
    WHERE binding.facture_source_allocation_id=v_deposit_source_id FOR UPDATE OF part;
  IF TG_TABLE_NAME='proforma_receipt_releases' THEN
    SELECT amount_ttc INTO assignment_amount FROM public.proforma_receipt_assignments
      WHERE id=NEW.assignment_id;
    SELECT COALESCE(sum(amount_ttc),0) INTO used_amount FROM public.proforma_receipt_releases WHERE assignment_id=NEW.assignment_id;
    IF assignment_amount IS NULL OR used_amount+NEW.amount_ttc>assignment_amount THEN
      RAISE EXCEPTION 'proforma release exceeds assigned receipt' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF parent_amount IS NULL OR NOT COALESCE(binding_valid,false) THEN
    RAISE EXCEPTION 'proforma receipt requires matching issued deposit and net allocated payment' USING ERRCODE='23514';
  END IF;
  SELECT COALESCE(sum(a.amount_ttc-COALESCE(r.amount,0)),0) INTO used_amount
    FROM public.proforma_receipt_assignments a
    LEFT JOIN LATERAL (SELECT sum(amount_ttc) AS amount FROM public.proforma_receipt_releases WHERE assignment_id=a.id) r ON true
    WHERE a.payment_allocation_id=v_payment_allocation_id;
  IF used_amount+NEW.amount_ttc>parent_amount THEN
    RAISE EXCEPTION 'proforma assignments exceed allocated payment' USING ERRCODE='23514';
  END IF;
  SELECT COALESCE(sum(a.amount_ttc-COALESCE(r.amount,0)),0) INTO used_amount
    FROM public.proforma_receipt_assignments a
    LEFT JOIN LATERAL (SELECT sum(amount_ttc) AS amount FROM public.proforma_receipt_releases WHERE assignment_id=a.id) r ON true
    WHERE a.deposit_source_id=v_deposit_source_id;
  IF used_amount+NEW.amount_ttc>source_amount THEN
    RAISE EXCEPTION 'proforma assignments exceed deposit line' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_proforma_receipt_budget_1268 ON public.proforma_receipt_assignments;
CREATE TRIGGER trg_proforma_receipt_budget_1268 BEFORE INSERT OR UPDATE OR DELETE ON public.proforma_receipt_assignments
  FOR EACH ROW EXECUTE FUNCTION public.fn_proforma_receipt_budget_1268();
DROP TRIGGER IF EXISTS trg_proforma_release_budget_1268 ON public.proforma_receipt_releases;
CREATE TRIGGER trg_proforma_release_budget_1268 BEFORE INSERT OR UPDATE OR DELETE ON public.proforma_receipt_releases
  FOR EACH ROW EXECUTE FUNCTION public.fn_proforma_receipt_budget_1268();

COMMENT ON TABLE public.proforma_client IS 'Commercial prepayment request; not a fiscal invoice. #1268';
COMMENT ON TABLE public.proforma_receipt_assignments IS 'Affair coverage from existing net payment allocations on issued deposit invoices; never a second cash entry. #1268';

CREATE OR REPLACE FUNCTION public.fn_protect_proforma_1268()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_id uuid; parent_status text;
BEGIN
  IF TG_TABLE_NAME='proforma_client' THEN
    IF TG_OP='DELETE' THEN RAISE EXCEPTION 'proforma history cannot be deleted' USING ERRCODE='55000'; END IF;
    PERFORM public.fn_lock_delivery_prepayment_write_1268();
    IF NEW.row_version<>OLD.row_version+1 THEN
      RAISE EXCEPTION 'proforma update requires next version' USING ERRCODE='23514';
    END IF;
    IF OLD.status='CANCELLED' OR (OLD.status='ISSUED' AND
      (NEW.status<>'CANCELLED' OR NEW.row_version<>OLD.row_version+1 OR
       (to_jsonb(NEW)-ARRAY['status','row_version','cancelled_at','cancelled_by','cancellation_reason']) IS DISTINCT FROM
       (to_jsonb(OLD)-ARRAY['status','row_version','cancelled_at','cancelled_by','cancellation_reason']))) THEN
      RAISE EXCEPTION 'issued proforma snapshot is immutable' USING ERRCODE='55000';
    END IF;
    IF NEW.status='ISSUED' AND OLD.status='DRAFT' AND
      (NOT EXISTS (SELECT 1 FROM public.proforma_affair_lines WHERE proforma_id=OLD.id)
       OR EXISTS (SELECT 1 FROM public.proforma_affair_lines line WHERE line.proforma_id=OLD.id
          AND NOT EXISTS (SELECT 1 FROM public.proforma_billing_parts part WHERE part.proforma_line_id=line.id))) THEN
      RAISE EXCEPTION 'proforma requires billed affairs before issuance' USING ERRCODE='23514';
    END IF;
    IF NEW.status='CANCELLED' AND EXISTS (
      SELECT 1 FROM public.proforma_affair_lines source
      JOIN public.bon_livraison_ligne_allocations allocation ON allocation.commande_ligne_affaire_allocation_id=source.allocation_id
      JOIN public.bon_livraison_ligne line ON line.id=allocation.bon_livraison_ligne_id
      JOIN public.bon_livraison delivery ON delivery.id=line.bon_livraison_id
      WHERE source.proforma_id=OLD.id AND delivery.statut IN ('READY','SHIPPED','DELIVERED')
    ) THEN RAISE EXCEPTION 'proforma delivery must be reconciled before cancellation' USING ERRCODE='23514'; END IF;
    IF NEW.status='CANCELLED' AND EXISTS (
      SELECT 1 FROM public.proforma_affair_lines line
      JOIN public.proforma_billing_parts part ON part.proforma_line_id=line.id
      JOIN public.proforma_deposit_sources binding ON binding.proforma_billing_part_id=part.id
      JOIN public.facture_source_allocations source ON source.id=binding.facture_source_allocation_id
      WHERE line.proforma_id=OLD.id AND source.allocation_status IN ('DRAFT','CONSUMED')
    ) THEN RAISE EXCEPTION 'proforma deposits must be reconciled before cancellation' USING ERRCODE='23514'; END IF;
    IF NEW.status='CANCELLED' AND EXISTS (
      SELECT 1 FROM public.proforma_affair_lines line
      JOIN public.proforma_billing_parts part ON part.proforma_line_id=line.id
      JOIN public.proforma_deposit_sources deposit ON deposit.proforma_billing_part_id=part.id
      JOIN public.proforma_receipt_assignments receipt ON receipt.deposit_source_id=deposit.facture_source_allocation_id
      WHERE line.proforma_id=OLD.id AND receipt.amount_ttc>
        COALESCE((SELECT sum(amount_ttc) FROM public.proforma_receipt_releases WHERE assignment_id=receipt.id),0)
    ) THEN RAISE EXCEPTION 'paid proforma requires receipt reconciliation before cancellation' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME='proforma_affair_lines' THEN
    parent_id:=CASE WHEN TG_OP='DELETE' THEN OLD.proforma_id ELSE NEW.proforma_id END;
    IF TG_OP='UPDATE' AND NEW.proforma_id<>OLD.proforma_id THEN
      RAISE EXCEPTION 'proforma line cannot change its parent' USING ERRCODE='55000';
    END IF;
    IF TG_OP<>'DELETE' AND NOT EXISTS (
      SELECT 1 FROM public.commande_ligne_affaire_allocation allocation
      JOIN public.commande_client command ON command.id=allocation.commande_id
      JOIN public.proforma_client proforma ON proforma.id=NEW.proforma_id
      WHERE allocation.id=NEW.allocation_id AND allocation.qty_ordered=NEW.quantity
        AND command.client_id::text=proforma.client_id AND command.order_type<>'INTERNE'
    ) THEN RAISE EXCEPTION 'proforma line must match its physical customer and affair quantity' USING ERRCODE='23514'; END IF;
  ELSE
    SELECT proforma_id INTO parent_id FROM public.proforma_affair_lines
      WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD.proforma_line_id ELSE NEW.proforma_line_id END;
    IF TG_OP='UPDATE' AND NEW.proforma_line_id<>OLD.proforma_line_id THEN
      RAISE EXCEPTION 'proforma billing part cannot change its parent' USING ERRCODE='55000';
    END IF;
  END IF;
  SELECT status INTO parent_status FROM public.proforma_client WHERE id=parent_id FOR UPDATE;
  IF parent_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'issued proforma child is immutable' USING ERRCODE='55000';
  END IF;
  -- NEW has the shape of the triggering table. A combined boolean expression
  -- can still resolve another table's fields before its table-name predicate.
  IF TG_TABLE_NAME='proforma_billing_parts' THEN
    IF TG_OP<>'DELETE' AND NOT EXISTS (
      SELECT 1 FROM public.delivery_affair_billing_shares share
      JOIN public.proforma_affair_lines line ON line.allocation_id=share.allocation_id
      WHERE share.id=NEW.billing_share_id AND line.id=NEW.proforma_line_id
        AND share.active AND share.billed_client_id=NEW.billed_client_id AND share.quantity=NEW.quantity
    ) THEN RAISE EXCEPTION 'proforma billing part differs from affair billing share' USING ERRCODE='23514'; END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_protect_proforma_1268 ON public.proforma_client;
CREATE TRIGGER trg_protect_proforma_1268 BEFORE UPDATE OR DELETE ON public.proforma_client
  FOR EACH ROW EXECUTE FUNCTION public.fn_protect_proforma_1268();
DROP TRIGGER IF EXISTS trg_protect_proforma_line_1268 ON public.proforma_affair_lines;
CREATE TRIGGER trg_protect_proforma_line_1268 BEFORE INSERT OR UPDATE OR DELETE ON public.proforma_affair_lines
  FOR EACH ROW EXECUTE FUNCTION public.fn_protect_proforma_1268();
DROP TRIGGER IF EXISTS trg_protect_proforma_part_1268 ON public.proforma_billing_parts;
CREATE TRIGGER trg_protect_proforma_part_1268 BEFORE INSERT OR UPDATE OR DELETE ON public.proforma_billing_parts
  FOR EACH ROW EXECUTE FUNCTION public.fn_protect_proforma_1268();

CREATE OR REPLACE FUNCTION public.fn_proforma_quantity_balance_1268()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_id bigint; line_id uuid; required_qty numeric(18,3); allocated_qty numeric(18,3);
BEGIN
  IF TG_TABLE_NAME='delivery_affair_billing_shares' THEN
    source_id:=CASE WHEN TG_OP='DELETE' THEN OLD.allocation_id ELSE NEW.allocation_id END;
    SELECT qty_ordered INTO required_qty FROM public.commande_ligne_affaire_allocation WHERE id=source_id FOR UPDATE;
    SELECT COALESCE(sum(quantity),0) INTO allocated_qty FROM public.delivery_affair_billing_shares WHERE allocation_id=source_id AND active;
    IF allocated_qty<>required_qty OR (SELECT count(DISTINCT plan_version) FROM public.delivery_affair_billing_shares WHERE allocation_id=source_id AND active)>1 THEN
      RAISE EXCEPTION 'billing shares must cover exactly the affair quantity' USING ERRCODE='23514';
    END IF;
  ELSE
    line_id:=CASE WHEN TG_OP='DELETE' THEN OLD.proforma_line_id ELSE NEW.proforma_line_id END;
    SELECT quantity INTO required_qty FROM public.proforma_affair_lines WHERE id=line_id FOR UPDATE;
    SELECT COALESCE(sum(quantity),0) INTO allocated_qty FROM public.proforma_billing_parts WHERE proforma_line_id=line_id;
    IF required_qty IS NOT NULL AND allocated_qty<>required_qty THEN
      RAISE EXCEPTION 'proforma billing parts must cover exactly the affair quantity' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS trg_billing_share_balance_1268 ON public.delivery_affair_billing_shares;
CREATE CONSTRAINT TRIGGER trg_billing_share_balance_1268 AFTER INSERT OR UPDATE OR DELETE ON public.delivery_affair_billing_shares
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.fn_proforma_quantity_balance_1268();
DROP TRIGGER IF EXISTS trg_proforma_part_balance_1268 ON public.proforma_billing_parts;
CREATE CONSTRAINT TRIGGER trg_proforma_part_balance_1268 AFTER INSERT OR UPDATE OR DELETE ON public.proforma_billing_parts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.fn_proforma_quantity_balance_1268();

CREATE OR REPLACE FUNCTION public.fn_proforma_source_binding_1268()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_valid boolean; previous_amount numeric(18,2); requested_amount numeric(18,2); part_amount numeric(18,2);
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'proforma deposit binding is immutable' USING ERRCODE='55000'; END IF;
  PERFORM public.fn_lock_delivery_prepayment_write_1268();
  SELECT source.source_type='DEPOSIT' AND source.source_id=line.proforma_id::text
    AND source.source_line_id=part.id::text AND invoice.client_id::text=part.billed_client_id
    AND invoice.currency=proforma.currency AND proforma.status='ISSUED'
    AND invoice.document_status='DRAFT' AND source.allocation_status='DRAFT',
    source.amount_incl_tax, part.total_incl_tax INTO source_valid,requested_amount,part_amount
    FROM public.proforma_billing_parts part
    JOIN public.proforma_affair_lines line ON line.id=part.proforma_line_id
    JOIN public.proforma_client proforma ON proforma.id=line.proforma_id
    JOIN public.facture_source_allocations source ON source.id=NEW.facture_source_allocation_id
    JOIN public.facture invoice ON invoice.id=source.facture_id
    WHERE part.id=NEW.proforma_billing_part_id FOR UPDATE OF part;
  IF NOT COALESCE(source_valid,false) THEN
    RAISE EXCEPTION 'deposit source must match proforma, billed company and currency' USING ERRCODE='23514';
  END IF;
  SELECT COALESCE(sum(source.amount_incl_tax),0) INTO previous_amount
    FROM public.proforma_deposit_sources binding
    JOIN public.facture_source_allocations source ON source.id=binding.facture_source_allocation_id
    WHERE binding.proforma_billing_part_id=NEW.proforma_billing_part_id
      AND source.allocation_status IN ('DRAFT','CONSUMED');
  IF requested_amount<=0 OR previous_amount+requested_amount>part_amount THEN
    RAISE EXCEPTION 'deposit sources exceed proforma billed part' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_proforma_deposit_binding_1268 ON public.proforma_deposit_sources;
CREATE TRIGGER trg_proforma_deposit_binding_1268 BEFORE INSERT OR UPDATE OR DELETE ON public.proforma_deposit_sources
  FOR EACH ROW EXECUTE FUNCTION public.fn_proforma_source_binding_1268();

CREATE OR REPLACE FUNCTION public.fn_proforma_terms_binding_1268()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_id bigint;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'prepayment decision history cannot be deleted' USING ERRCODE='55000'; END IF;
  PERFORM public.fn_lock_delivery_prepayment_write_1268();
  source_id:=NEW.allocation_id;
  PERFORM 1 FROM public.commande_ligne_affaire_allocation WHERE id=source_id FOR UPDATE;
  IF TG_OP='UPDATE' AND (NEW.allocation_id<>OLD.allocation_id OR NEW.row_version<>OLD.row_version+1) THEN
    RAISE EXCEPTION 'prepayment decision requires stable source and next version' USING ERRCODE='23514';
  END IF;
  IF NEW.proforma_line_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.proforma_affair_lines line WHERE line.id=NEW.proforma_line_id AND line.allocation_id=source_id
  ) THEN RAISE EXCEPTION 'proforma does not belong to this affair' USING ERRCODE='23514'; END IF;
  IF ((TG_OP='UPDATE' AND (NEW.requirement IS DISTINCT FROM OLD.requirement OR NEW.proforma_line_id IS DISTINCT FROM OLD.proforma_line_id))
    OR (TG_OP='INSERT' AND NEW.requirement='PROFORMA'))
    AND EXISTS (SELECT 1 FROM public.bon_livraison_ligne_allocations allocation
      JOIN public.bon_livraison_ligne line ON line.id=allocation.bon_livraison_ligne_id
      JOIN public.bon_livraison delivery ON delivery.id=line.bon_livraison_id
      WHERE allocation.commande_ligne_affaire_allocation_id=source_id
        AND delivery.statut IN ('READY','SHIPPED','DELIVERED')) THEN
    RAISE EXCEPTION 'delivery already uses these prepayment terms' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_proforma_terms_binding_1268 ON public.delivery_affair_prepayment_terms;
CREATE TRIGGER trg_proforma_terms_binding_1268 BEFORE INSERT OR UPDATE OR DELETE ON public.delivery_affair_prepayment_terms
  FOR EACH ROW EXECUTE FUNCTION public.fn_proforma_terms_binding_1268();

CREATE OR REPLACE FUNCTION public.fn_proforma_share_identity_1268()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.fn_lock_delivery_prepayment_write_1268();
  IF TG_OP='INSERT' THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND (NEW.allocation_id<>OLD.allocation_id OR NEW.row_version<>OLD.row_version+1) THEN
    RAISE EXCEPTION 'billing share requires stable source and next version' USING ERRCODE='23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.proforma_billing_parts part
    JOIN public.proforma_affair_lines line ON line.id=part.proforma_line_id
    JOIN public.proforma_client proforma ON proforma.id=line.proforma_id
    WHERE part.billing_share_id=OLD.id AND proforma.status<>'DRAFT') THEN
    IF TG_OP<>'UPDATE' OR NEW.active OR NOT OLD.active OR
      (to_jsonb(NEW)-ARRAY['active','row_version']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['active','row_version']) OR EXISTS (
        SELECT 1 FROM public.proforma_billing_parts part JOIN public.proforma_affair_lines line ON line.id=part.proforma_line_id
        JOIN public.proforma_client proforma ON proforma.id=line.proforma_id
        WHERE part.billing_share_id=OLD.id AND proforma.status='ISSUED') THEN
      RAISE EXCEPTION 'issued billing distribution is immutable' USING ERRCODE='55000';
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM public.bon_livraison_ligne_allocations allocation
    JOIN public.bon_livraison_ligne line ON line.id=allocation.bon_livraison_ligne_id
    JOIN public.bon_livraison delivery ON delivery.id=line.bon_livraison_id
    WHERE allocation.commande_ligne_affaire_allocation_id=OLD.allocation_id
      AND delivery.statut IN ('READY','SHIPPED','DELIVERED')) THEN
    RAISE EXCEPTION 'delivery already uses this billing distribution' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_proforma_share_identity_1268 ON public.delivery_affair_billing_shares;
CREATE TRIGGER trg_proforma_share_identity_1268 BEFORE INSERT OR UPDATE OR DELETE ON public.delivery_affair_billing_shares
  FOR EACH ROW EXECUTE FUNCTION public.fn_proforma_share_identity_1268();

-- Source-specific guard. The canonical #469 payment and credit guards keep
-- their existing function and trigger bindings; only invoice source dispatch
-- is replaced. DEPOSIT consumes a monetary advance, never physical pieces.
CREATE OR REPLACE FUNCTION public.fn_validate_invoice_source_1268()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_qty numeric(18,3); used_qty numeric(18,3); source_client text; target_client text;
  source_valid boolean; part_ht numeric(18,2); part_ttc numeric(18,2); used_ht numeric(18,2); used_ttc numeric(18,2);
  has_proforma boolean; billed_party_authorized boolean;
BEGIN
  IF NEW.source_type='DELIVERY_LINE' THEN
    SELECT line.quantite::numeric(18,3),delivery.client_id,invoice.client_id INTO source_qty,source_client,target_client
    FROM public.bon_livraison_ligne line JOIN public.bon_livraison delivery ON delivery.id=line.bon_livraison_id
    JOIN public.facture invoice ON invoice.id=NEW.facture_id
    WHERE line.id::text=NEW.source_line_id AND delivery.id::text=NEW.source_id FOR UPDATE OF line,delivery,invoice;
    SELECT COALESCE(sum(quantity_selected),0)::numeric(18,3) INTO used_qty FROM public.facture_source_allocations
      WHERE source_type='DELIVERY_LINE' AND source_line_id=NEW.source_line_id AND allocation_status IN ('DRAFT','CONSUMED');
    SELECT EXISTS (
      SELECT 1 FROM public.bon_livraison_ligne_allocations delivered
      LEFT JOIN public.stock_reservations reservation ON reservation.id=delivered.reservation_id
      JOIN public.commande_ligne_affaire_allocation affair ON affair.id=
        COALESCE(delivered.commande_ligne_affaire_allocation_id,reservation.commande_ligne_affaire_allocation_id)
      JOIN public.commande_client command ON command.id=affair.commande_id
      LEFT JOIN public.delivery_affair_prepayment_terms terms ON terms.allocation_id=affair.id
      WHERE delivered.bon_livraison_ligne_id::text=NEW.source_line_id
        AND COALESCE(terms.requirement,command.delivery_prepayment_requirement,'UNCONFIRMED')='PROFORMA'
    ) INTO has_proforma;
    SELECT EXISTS (
      SELECT 1 FROM public.bon_livraison_ligne_allocations delivered
      LEFT JOIN public.stock_reservations reservation ON reservation.id=delivered.reservation_id
      JOIN public.delivery_affair_prepayment_terms terms ON terms.allocation_id=
        COALESCE(delivered.commande_ligne_affaire_allocation_id,reservation.commande_ligne_affaire_allocation_id)
      JOIN public.proforma_affair_lines proforma_line ON proforma_line.id=terms.proforma_line_id
      JOIN public.proforma_client proforma ON proforma.id=proforma_line.proforma_id
      JOIN public.proforma_billing_parts part ON part.proforma_line_id=proforma_line.id
      JOIN public.facture invoice ON invoice.id=NEW.facture_id
      WHERE delivered.bon_livraison_ligne_id::text=NEW.source_line_id AND terms.requirement='PROFORMA'
        AND proforma.status='ISSUED' AND proforma.currency=invoice.currency AND part.billed_client_id=target_client
    ) INTO billed_party_authorized;
    IF source_qty IS NULL OR (has_proforma AND NOT billed_party_authorized)
      OR (NOT has_proforma AND source_client IS DISTINCT FROM target_client) OR used_qty+NEW.quantity_selected>source_qty THEN
      RAISE EXCEPTION 'invoice source allocations have a client mismatch or exceed delivered quantity' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.source_type='DEPOSIT' THEN
    PERFORM public.fn_lock_delivery_prepayment_write_1268();
    SELECT proforma.status='ISSUED' AND invoice.document_status='DRAFT'
      AND invoice.client_id::text=part.billed_client_id AND invoice.currency=proforma.currency
      AND invoice_line.facture_id=invoice.id AND invoice_line.quantite=1
      AND invoice.remise_globale=0 AND invoice_line.remise_ligne=0 AND invoice_line.taux_tva=part.tax_rate_percent
      AND invoice_line.prix_unitaire_ht=NEW.amount_ex_tax
      AND invoice_line.total_ht=NEW.amount_ex_tax AND invoice_line.total_ttc=NEW.amount_incl_tax,
      part.total_ex_tax,part.total_incl_tax INTO source_valid,part_ht,part_ttc
    FROM public.proforma_billing_parts part JOIN public.proforma_affair_lines line ON line.id=part.proforma_line_id
    JOIN public.proforma_client proforma ON proforma.id=line.proforma_id
    JOIN public.facture invoice ON invoice.id=NEW.facture_id
    JOIN public.facture_ligne invoice_line ON invoice_line.id=NEW.facture_ligne_id
    WHERE part.id::text=NEW.source_line_id AND line.proforma_id::text=NEW.source_id FOR UPDATE OF part,invoice;
    IF NOT COALESCE(source_valid,false) OR NEW.allocation_status<>'DRAFT' OR NEW.quantity_selected<>1
      OR NEW.amount_ex_tax<=0 OR NEW.amount_incl_tax<NEW.amount_ex_tax THEN
      RAISE EXCEPTION 'deposit source requires an issued proforma, matching draft invoice and billed part' USING ERRCODE='23514';
    END IF;
    SELECT COALESCE(sum(amount_ex_tax),0),COALESCE(sum(amount_incl_tax),0) INTO used_ht,used_ttc
      FROM public.facture_source_allocations WHERE source_type='DEPOSIT' AND source_line_id=NEW.source_line_id
        AND allocation_status IN ('DRAFT','CONSUMED');
    IF used_ht+NEW.amount_ex_tax>part_ht OR used_ttc+NEW.amount_incl_tax>part_ttc THEN
      RAISE EXCEPTION 'deposit sources exceed proforma billed part' USING ERRCODE='23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'invoice source has no qualified contractual rule' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_validate_facture_source_allocation_227 ON public.facture_source_allocations;
CREATE TRIGGER trg_validate_facture_source_allocation_227 BEFORE INSERT ON public.facture_source_allocations
  FOR EACH ROW EXECUTE FUNCTION public.fn_validate_invoice_source_1268();

CREATE OR REPLACE FUNCTION public.fn_require_deposit_binding_1268()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Deferred events must check the current row, not an earlier INSERT image
  -- if the draft was explicitly reversed later in the same transaction.
  IF EXISTS(SELECT 1 FROM public.facture_source_allocations source WHERE source.id=NEW.id
      AND source.source_type='DEPOSIT' AND source.allocation_status IN ('DRAFT','CONSUMED')) THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.proforma_deposit_sources binding JOIN public.proforma_billing_parts part ON part.id=binding.proforma_billing_part_id
      JOIN public.proforma_affair_lines line ON line.id=part.proforma_line_id
      JOIN public.proforma_client proforma ON proforma.id=line.proforma_id
      JOIN public.facture_source_allocations current_source ON current_source.id=binding.facture_source_allocation_id
      JOIN public.facture invoice ON invoice.id=current_source.facture_id
      WHERE binding.facture_source_allocation_id=NEW.id AND part.id::text=current_source.source_line_id
        AND line.proforma_id::text=current_source.source_id AND proforma.status='ISSUED'
        AND invoice.client_id::text=part.billed_client_id AND invoice.currency=proforma.currency
    ) THEN RAISE EXCEPTION 'deposit source requires retained proforma fiscal lineage' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS trg_require_deposit_binding_1268 ON public.facture_source_allocations;
CREATE CONSTRAINT TRIGGER trg_require_deposit_binding_1268 AFTER INSERT OR UPDATE ON public.facture_source_allocations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.fn_require_deposit_binding_1268();

CREATE OR REPLACE FUNCTION public.fn_proforma_final_binding_1268()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE valid_binding boolean; part_qty numeric(18,3); physical_qty numeric(18,3);
  used_part_qty numeric(18,3); used_physical_qty numeric(18,3); v_source_line_id text; v_affair_id bigint;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'final invoice proforma lineage is append only' USING ERRCODE='55000'; END IF;
  PERFORM public.fn_lock_delivery_prepayment_write_1268();
  SELECT source.source_type='DELIVERY_LINE' AND source.allocation_status='DRAFT'
    AND source.source_id=delivery.id::text AND delivery.statut IN ('SHIPPED','DELIVERED')
    AND invoice.document_status='DRAFT' AND invoice.client_id::text=part.billed_client_id
    AND invoice.currency=proforma.currency AND proforma.status='ISSUED' AND terms.requirement='PROFORMA'
    AND delivered_line.commande_ligne_id=affair.commande_ligne_id AND terms.allocation_id=affair.id
    AND invoice_line.facture_id=invoice.id AND invoice_line.quantite=source.quantity_selected
    AND invoice_line.prix_unitaire_ht=part.unit_price_ex_tax AND invoice_line.remise_ligne=part.discount_percent
    AND invoice_line.taux_tva=part.tax_rate_percent AND invoice.remise_globale=part.global_discount_percent,
    part.quantity,source.source_line_id,proforma_line.allocation_id
    INTO valid_binding,part_qty,v_source_line_id,v_affair_id
  FROM public.facture_source_allocations source
  JOIN public.facture invoice ON invoice.id=source.facture_id
  JOIN public.facture_ligne invoice_line ON invoice_line.id=source.facture_ligne_id
  JOIN public.bon_livraison_ligne delivered_line ON delivered_line.id::text=source.source_line_id
  JOIN public.bon_livraison delivery ON delivery.id=delivered_line.bon_livraison_id
  JOIN public.proforma_billing_parts part ON part.id=NEW.proforma_billing_part_id
  JOIN public.proforma_affair_lines proforma_line ON proforma_line.id=part.proforma_line_id
  JOIN public.commande_ligne_affaire_allocation affair ON affair.id=proforma_line.allocation_id
  JOIN public.proforma_client proforma ON proforma.id=proforma_line.proforma_id
  JOIN public.delivery_affair_prepayment_terms terms ON terms.proforma_line_id=proforma_line.id
  WHERE source.id=NEW.facture_source_allocation_id FOR UPDATE OF part,source,invoice;
  IF NOT COALESCE(valid_binding,false) THEN RAISE EXCEPTION 'final invoice needs issued proforma company and frozen prices' USING ERRCODE='23514'; END IF;
  SELECT sum(delivered.quantite) INTO physical_qty
  FROM public.bon_livraison_ligne_allocations delivered
  LEFT JOIN public.stock_reservations reservation ON reservation.id=delivered.reservation_id
  WHERE delivered.bon_livraison_ligne_id::text=v_source_line_id
    AND COALESCE(delivered.commande_ligne_affaire_allocation_id,reservation.commande_ligne_affaire_allocation_id)=v_affair_id;
  SELECT COALESCE(sum(binding.quantity),0) INTO used_part_qty
  FROM public.proforma_final_invoice_sources binding
  JOIN public.facture_source_allocations source ON source.id=binding.facture_source_allocation_id
  WHERE binding.proforma_billing_part_id=NEW.proforma_billing_part_id AND source.allocation_status IN ('DRAFT','CONSUMED');
  SELECT COALESCE(sum(binding.quantity),0) INTO used_physical_qty
  FROM public.proforma_final_invoice_sources binding
  JOIN public.facture_source_allocations source ON source.id=binding.facture_source_allocation_id
  JOIN public.proforma_billing_parts used_part ON used_part.id=binding.proforma_billing_part_id
  JOIN public.proforma_affair_lines used_line ON used_line.id=used_part.proforma_line_id
  WHERE source.source_line_id=v_source_line_id AND used_line.allocation_id=v_affair_id
    AND source.allocation_status IN ('DRAFT','CONSUMED');
  IF physical_qty IS NULL OR used_physical_qty+NEW.quantity>physical_qty OR used_part_qty+NEW.quantity>part_qty THEN
    RAISE EXCEPTION 'final invoice quantities exceed delivered affair or billed company quota' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_proforma_final_binding_1268 ON public.proforma_final_invoice_sources;
CREATE TRIGGER trg_proforma_final_binding_1268 BEFORE INSERT OR UPDATE OR DELETE ON public.proforma_final_invoice_sources
  FOR EACH ROW EXECUTE FUNCTION public.fn_proforma_final_binding_1268();

CREATE OR REPLACE FUNCTION public.fn_require_final_binding_1268()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source public.facture_source_allocations%ROWTYPE; linked_qty numeric(18,3); has_proforma boolean;
BEGIN
  SELECT * INTO source FROM public.facture_source_allocations WHERE id=NEW.id;
  IF NOT FOUND OR source.source_type<>'DELIVERY_LINE' OR source.allocation_status NOT IN ('DRAFT','CONSUMED') THEN RETURN NULL; END IF;
  SELECT EXISTS (
    SELECT 1 FROM public.bon_livraison_ligne_allocations delivered
    LEFT JOIN public.stock_reservations reservation ON reservation.id=delivered.reservation_id
    JOIN public.commande_ligne_affaire_allocation affair ON affair.id=
      COALESCE(delivered.commande_ligne_affaire_allocation_id,reservation.commande_ligne_affaire_allocation_id)
    JOIN public.commande_client command ON command.id=affair.commande_id
    LEFT JOIN public.delivery_affair_prepayment_terms terms ON terms.allocation_id=affair.id
    WHERE delivered.bon_livraison_ligne_id::text=source.source_line_id
      AND COALESCE(terms.requirement,command.delivery_prepayment_requirement,'UNCONFIRMED')='PROFORMA'
  ) INTO has_proforma;
  SELECT COALESCE(sum(quantity),0) INTO linked_qty FROM public.proforma_final_invoice_sources
    WHERE facture_source_allocation_id=source.id;
  IF (has_proforma AND linked_qty<>source.quantity_selected) OR (NOT has_proforma AND linked_qty<>0) THEN
    RAISE EXCEPTION 'final invoice requires exact retained proforma company quantities' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS trg_require_final_binding_1268 ON public.facture_source_allocations;
CREATE CONSTRAINT TRIGGER trg_require_final_binding_1268 AFTER INSERT OR UPDATE ON public.facture_source_allocations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.fn_require_final_binding_1268();

-- Schema runners may operate as postgres, whereas API transactions use cerp_app.
-- Evidence is retained; only draft children can be removed under their guards.
GRANT SELECT,INSERT,UPDATE ON public.proforma_client,public.delivery_affair_billing_shares,
  public.delivery_affair_prepayment_terms TO cerp_app;
REVOKE DELETE,TRUNCATE ON public.proforma_client,public.delivery_affair_billing_shares,
  public.delivery_affair_prepayment_terms FROM cerp_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.proforma_affair_lines,public.proforma_billing_parts TO cerp_app;
REVOKE TRUNCATE ON public.proforma_affair_lines,public.proforma_billing_parts FROM cerp_app;
GRANT SELECT,INSERT ON public.proforma_deposit_sources,public.proforma_receipt_assignments,public.proforma_receipt_releases TO cerp_app;
REVOKE UPDATE,DELETE,TRUNCATE ON public.proforma_deposit_sources,public.proforma_receipt_assignments,public.proforma_receipt_releases FROM cerp_app;
GRANT SELECT,INSERT ON public.proforma_final_invoice_sources TO cerp_app;
REVOKE UPDATE,DELETE,TRUNCATE ON public.proforma_final_invoice_sources FROM cerp_app;
GRANT USAGE,SELECT ON SEQUENCE public.proforma_client_reference_seq TO cerp_app;

-- Applied advances are settlement evidence, not another bank movement.
CREATE OR REPLACE FUNCTION public.fn_invoice_applied_prepayment_1268(p_invoice_id bigint)
RETURNS numeric LANGUAGE sql STABLE AS $$
 SELECT COALESCE(sum(applied.amount_ttc),0)
 FROM public.proforma_final_prepayments applied
 JOIN public.facture_source_allocations final ON final.id=applied.final_source_allocation_id AND final.allocation_status='CONSUMED'
 JOIN public.proforma_receipt_assignments receipt ON receipt.id=applied.receipt_assignment_id
 JOIN public.paiement_allocations allocation ON allocation.id=receipt.payment_allocation_id
 JOIN public.paiement payment ON payment.id=allocation.paiement_id
 JOIN public.facture_source_allocations deposit ON deposit.id=applied.deposit_source_id AND deposit.allocation_status='CONSUMED'
 JOIN public.facture advance_invoice ON advance_invoice.id=deposit.facture_id AND advance_invoice.document_status='ISSUED'
 WHERE final.facture_id=p_invoice_id AND payment.status IN('UNALLOCATED','PARTIALLY_ALLOCATED','ALLOCATED')
  AND payment.workflow_status IN('RECORDED','ALLOCATED') AND payment.reversal_of_id IS NULL;
$$;
GRANT EXECUTE ON FUNCTION public.fn_invoice_applied_prepayment_1268(bigint) TO cerp_app;

-- Deferred guards see the complete draft/issue transaction, including due dates.
-- Historical invoices with no new due-at-issue value remain untouched.
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
   IF v_settled>invoice.total_ttc THEN RAISE EXCEPTION 'cash credits and applied advances exceed final invoice' USING ERRCODE='23514'; END IF;
  END IF;
 END LOOP;
 RETURN NULL;
END;
$$;
DO $$ DECLARE guarded_table text; BEGIN
 FOREACH guarded_table IN ARRAY ARRAY['facture','facture_source_allocations','facture_echeance','proforma_final_prepayments',
   'paiement','paiement_allocations','avoir','avoir_source_allocations','proforma_receipt_assignments','proforma_receipt_releases'] LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS trg_check_final_prepayments_1268 ON public.%I',guarded_table);
  EXECUTE format('CREATE CONSTRAINT TRIGGER trg_check_final_prepayments_1268 AFTER INSERT OR UPDATE OR DELETE ON public.%I
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.fn_check_final_prepayments_1268()',guarded_table);
 END LOOP;
END $$;
