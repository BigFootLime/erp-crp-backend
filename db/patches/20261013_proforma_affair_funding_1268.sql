-- #1268: physical customer, billed companies and cash evidence stay distinct.
-- No existing affair is implicitly migrated to "not prepaid".
CREATE SEQUENCE IF NOT EXISTS public.proforma_client_reference_seq;

-- Existing commercial prices have the same EUR basis as Finance #227.
ALTER TABLE public.commande_client ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'EUR';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.commande_client'::regclass AND conname='commande_currency_1268_ck') THEN
    ALTER TABLE public.commande_client ADD CONSTRAINT commande_currency_1268_ck CHECK (currency ~ '^[A-Z]{3}$');
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

CREATE OR REPLACE FUNCTION public.fn_proforma_receipt_budget_1268()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  payment_id uuid; source_id uuid; parent_amount numeric(18,2);
  source_amount numeric(18,2); used_amount numeric(18,2); binding_valid boolean;
  assignment_amount numeric(18,2);
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'proforma receipt evidence is append only' USING ERRCODE='55000';
  END IF;
  -- BL mutations retain the shared lock. Binding/receipt changes use its
  -- exclusive form before parent locks, including the repository command.
  PERFORM pg_advisory_xact_lock(hashtextextended('delivery-prepayment-binding',0));
  IF TG_TABLE_NAME='proforma_receipt_releases' THEN
    SELECT payment_allocation_id,deposit_source_id INTO payment_id,source_id
      FROM public.proforma_receipt_assignments WHERE id=NEW.assignment_id;
  ELSE
    payment_id:=NEW.payment_allocation_id; source_id:=NEW.deposit_source_id;
  END IF;
  SELECT amount_ttc INTO parent_amount FROM public.paiement_allocations WHERE id=payment_id FOR UPDATE;
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
    JOIN public.paiement_allocations allocation ON allocation.id=payment_id
    JOIN public.paiement payment ON payment.id=allocation.paiement_id
    WHERE binding.facture_source_allocation_id=source_id FOR UPDATE OF part;
  IF TG_TABLE_NAME='proforma_receipt_releases' THEN
    SELECT amount_ttc INTO assignment_amount FROM public.proforma_receipt_assignments
      WHERE id=NEW.assignment_id FOR UPDATE;
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
    WHERE a.payment_allocation_id=payment_id;
  IF used_amount+NEW.amount_ttc>parent_amount THEN
    RAISE EXCEPTION 'proforma assignments exceed allocated payment' USING ERRCODE='23514';
  END IF;
  SELECT COALESCE(sum(a.amount_ttc-COALESCE(r.amount,0)),0) INTO used_amount
    FROM public.proforma_receipt_assignments a
    LEFT JOIN LATERAL (SELECT sum(amount_ttc) AS amount FROM public.proforma_receipt_releases WHERE assignment_id=a.id) r ON true
    WHERE a.deposit_source_id=source_id;
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
    PERFORM pg_advisory_xact_lock(hashtextextended('delivery-prepayment-binding',0));
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
  PERFORM pg_advisory_xact_lock(hashtextextended('delivery-prepayment-binding',0));
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
  PERFORM pg_advisory_xact_lock(hashtextextended('delivery-prepayment-binding',0));
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
        AND delivery.statut IN ('DRAFT','READY','SHIPPED','DELIVERED')) THEN
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
  PERFORM pg_advisory_xact_lock(hashtextextended('delivery-prepayment-binding',0));
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
      AND delivery.statut IN ('DRAFT','READY','SHIPPED','DELIVERED')) THEN
    RAISE EXCEPTION 'delivery already uses this billing distribution' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_proforma_share_identity_1268 ON public.delivery_affair_billing_shares;
CREATE TRIGGER trg_proforma_share_identity_1268 BEFORE INSERT OR UPDATE OR DELETE ON public.delivery_affair_billing_shares
  FOR EACH ROW EXECUTE FUNCTION public.fn_proforma_share_identity_1268();

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
GRANT USAGE,SELECT ON SEQUENCE public.proforma_client_reference_seq TO cerp_app;
