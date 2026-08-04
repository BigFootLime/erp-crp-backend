-- Roll back the #469 schema contract. Derived columns are removed; historical rows are untouched.
--
-- Controlled production procedure (never run from application startup):
--   1. stop/drain Finance writes;
--   2. deploy the previous application version (it tolerates the additive columns);
--   3. in this same psql session set both explicit acknowledgements below;
--   4. run this script, verify COMMIT, then reopen Finance writes.
--
--   SET cerp.finance_469_application_rolled_back = 'YES';
--   SET cerp.finance_469_rollback_authorized = 'YES';
BEGIN;

DO $$
BEGIN
  IF current_database() <> 'cerp_test'
     AND (
       COALESCE(current_setting('cerp.finance_469_application_rolled_back', true), '') <> 'YES'
       OR COALESCE(current_setting('cerp.finance_469_rollback_authorized', true), '') <> 'YES'
     ) THEN
    RAISE EXCEPTION '#469 rollback outside cerp_test requires an app rollback and two explicit session acknowledgements';
  END IF;
END $$;

DROP INDEX IF EXISTS public.facture_document_settlement_469_idx;
ALTER TABLE public.facture DROP CONSTRAINT IF EXISTS facture_statut_469_ck;
ALTER TABLE public.facture DROP CONSTRAINT IF EXISTS facture_document_status_469_ck;
ALTER TABLE public.facture DROP CONSTRAINT IF EXISTS facture_settlement_status_469_ck;
ALTER TABLE public.avoir DROP CONSTRAINT IF EXISTS avoir_statut_469_ck;

CREATE OR REPLACE FUNCTION public.fn_protect_facturation_immutable_227()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.statut IN (
      'ISSUED', 'PARTIALLY_PAID', 'PAID', 'CANCELLED',
      'emise', 'envoyee', 'partielle', 'payee', 'annulee', 'emis', 'annule'
    ) THEN
      RAISE EXCEPTION 'issued or cancelled finance evidence cannot be deleted' USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.statut IN (
    'ISSUED', 'PARTIALLY_PAID', 'PAID', 'CANCELLED',
    'emise', 'envoyee', 'partielle', 'payee', 'annulee', 'emis', 'annule'
  ) THEN
    RAISE EXCEPTION 'issued or cancelled finance evidence is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.statut = 'DRAFT' AND NEW.statut = 'CANCELLED' THEN
    RAISE EXCEPTION 'draft finance evidence must not be cancelled as legal evidence' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- Restore the exact corrected #227 child policy shipped by patch #275.
CREATE OR REPLACE FUNCTION public.fn_protect_facturation_child_227()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent_status text;
BEGIN
  IF TG_TABLE_NAME IN ('facture_ligne', 'facture_source_allocations', 'facture_echeance') THEN
    IF TG_OP = 'DELETE' THEN
      SELECT statut INTO parent_status FROM public.facture WHERE id = OLD.facture_id;
    ELSE
      SELECT statut INTO parent_status FROM public.facture WHERE id = NEW.facture_id;
    END IF;
  ELSIF TG_TABLE_NAME = 'avoir_ligne' THEN
    IF TG_OP = 'DELETE' THEN
      SELECT statut INTO parent_status FROM public.avoir WHERE id = OLD.avoir_id;
    ELSE
      SELECT statut INTO parent_status FROM public.avoir WHERE id = NEW.avoir_id;
    END IF;
  ELSIF TG_TABLE_NAME = 'avoir_source_allocations' THEN
    IF TG_OP = 'DELETE' THEN
      SELECT statut INTO parent_status FROM public.avoir WHERE id = OLD.avoir_id;
    ELSE
      SELECT statut INTO parent_status FROM public.avoir WHERE id = NEW.avoir_id;
    END IF;
  END IF;

  IF TG_TABLE_NAME = 'facture_echeance' AND TG_OP = 'UPDATE' THEN
    IF parent_status IN ('ISSUED', 'PARTIALLY_PAID', 'PAID')
       AND NEW.facture_id = OLD.facture_id
       AND NEW.due_date = OLD.due_date
       AND NEW.label = OLD.label
       AND NEW.amount_due = OLD.amount_due
       AND NEW.created_by = OLD.created_by
       AND NEW.amount_allocated >= OLD.amount_allocated THEN
      RETURN NEW;
    END IF;
  END IF;

  IF parent_status IN (
    'ISSUED', 'PARTIALLY_PAID', 'PAID', 'CANCELLED',
    'emise', 'envoyee', 'partielle', 'payee', 'annulee', 'emis', 'annule'
  ) THEN
    RAISE EXCEPTION 'children of issued or cancelled finance evidence are immutable' USING ERRCODE = '55000';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

-- Restore the exact #227 allocation validator and INSERT-only trigger contract.
CREATE OR REPLACE FUNCTION public.fn_validate_facturation_allocation_227()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  payment_amount numeric(18,2);
  allocated_amount numeric(18,2);
  invoice_amount numeric(18,2);
  invoice_allocated numeric(18,2);
  credit_amount numeric(18,2);
  credit_allocated numeric(18,2);
  delivery_qty numeric(18,3);
  sourced_qty numeric(18,3);
  source_client text;
  target_client text;
BEGIN
  IF TG_TABLE_NAME = 'paiement_allocations' THEN
    SELECT montant::numeric(18,2) INTO payment_amount FROM public.paiement WHERE id = NEW.paiement_id FOR UPDATE;
    SELECT COALESCE(SUM(amount_ttc), 0)::numeric(18,2) INTO allocated_amount
    FROM public.paiement_allocations WHERE paiement_id = NEW.paiement_id;
    IF payment_amount IS NULL OR allocated_amount + NEW.amount_ttc > payment_amount THEN
      RAISE EXCEPTION 'payment allocations exceed recorded payment' USING ERRCODE = '23514';
    END IF;
    SELECT total_ttc::numeric(18,2) INTO invoice_amount FROM public.facture WHERE id = NEW.facture_id FOR UPDATE;
    SELECT COALESCE(SUM(amount_ttc), 0)::numeric(18,2) INTO invoice_allocated
    FROM public.paiement_allocations WHERE facture_id = NEW.facture_id;
    SELECT COALESCE(SUM(amount_ttc), 0)::numeric(18,2) INTO credit_allocated
    FROM public.avoir_source_allocations WHERE facture_id = NEW.facture_id;
    IF invoice_amount IS NULL OR invoice_allocated + credit_allocated + NEW.amount_ttc > invoice_amount THEN
      RAISE EXCEPTION 'payment and credit allocations exceed invoice total' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'avoir_source_allocations' THEN
    SELECT a.total_ttc::numeric(18,2), a.client_id, f.client_id
    INTO credit_amount, source_client, target_client
    FROM public.avoir a JOIN public.facture f ON f.id = NEW.facture_id
    WHERE a.id = NEW.avoir_id FOR UPDATE;
    SELECT COALESCE(SUM(amount_ttc), 0)::numeric(18,2) INTO credit_allocated
    FROM public.avoir_source_allocations WHERE avoir_id = NEW.avoir_id;
    IF source_client IS DISTINCT FROM target_client OR credit_amount IS NULL OR credit_allocated + NEW.amount_ttc > credit_amount THEN
      RAISE EXCEPTION 'credit allocation has a client mismatch or exceeds the credit note' USING ERRCODE = '23514';
    END IF;
    SELECT total_ttc::numeric(18,2) INTO invoice_amount FROM public.facture WHERE id = NEW.facture_id FOR UPDATE;
    SELECT COALESCE(SUM(amount_ttc), 0)::numeric(18,2) INTO invoice_allocated
    FROM public.paiement_allocations WHERE facture_id = NEW.facture_id;
    IF invoice_amount IS NULL OR invoice_allocated + credit_allocated + NEW.amount_ttc > invoice_amount THEN
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

CREATE OR REPLACE FUNCTION public.fn_protect_paiement_227()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.uuid IS NULL THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'recorded payment evidence cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF NEW.uuid IS DISTINCT FROM OLD.uuid
     OR NEW.code IS DISTINCT FROM OLD.code
     OR NEW.client_id IS DISTINCT FROM OLD.client_id
     OR NEW.facture_id IS DISTINCT FROM OLD.facture_id
     OR NEW.montant IS DISTINCT FROM OLD.montant
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.date_paiement IS DISTINCT FROM OLD.date_paiement
     OR NEW.value_date IS DISTINCT FROM OLD.value_date
     OR NEW.booking_date IS DISTINCT FROM OLD.booking_date
     OR NEW.mode IS DISTINCT FROM OLD.mode
     OR NEW.reference IS DISTINCT FROM OLD.reference
     OR NEW.commentaire IS DISTINCT FROM OLD.commentaire
     OR NEW.proof_document_id IS DISTINCT FROM OLD.proof_document_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'recorded payment identity and amount are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

-- Restore every original #227 binding for the three restored function bodies.
DROP TRIGGER IF EXISTS trg_protect_facture_ligne_227 ON public.facture_ligne;
CREATE TRIGGER trg_protect_facture_ligne_227 BEFORE INSERT OR UPDATE OR DELETE ON public.facture_ligne
FOR EACH ROW EXECUTE FUNCTION public.fn_protect_facturation_child_227();
DROP TRIGGER IF EXISTS trg_protect_avoir_ligne_227 ON public.avoir_ligne;
CREATE TRIGGER trg_protect_avoir_ligne_227 BEFORE INSERT OR UPDATE OR DELETE ON public.avoir_ligne
FOR EACH ROW EXECUTE FUNCTION public.fn_protect_facturation_child_227();
DROP TRIGGER IF EXISTS trg_protect_facture_source_227 ON public.facture_source_allocations;
CREATE TRIGGER trg_protect_facture_source_227 BEFORE INSERT OR UPDATE OR DELETE ON public.facture_source_allocations
FOR EACH ROW EXECUTE FUNCTION public.fn_protect_facturation_child_227();
DROP TRIGGER IF EXISTS trg_protect_facture_echeance_227 ON public.facture_echeance;
CREATE TRIGGER trg_protect_facture_echeance_227 BEFORE INSERT OR UPDATE OR DELETE ON public.facture_echeance
FOR EACH ROW EXECUTE FUNCTION public.fn_protect_facturation_child_227();
DROP TRIGGER IF EXISTS trg_protect_avoir_source_227 ON public.avoir_source_allocations;
CREATE TRIGGER trg_protect_avoir_source_227 BEFORE INSERT OR UPDATE OR DELETE ON public.avoir_source_allocations
FOR EACH ROW EXECUTE FUNCTION public.fn_protect_facturation_child_227();

DROP TRIGGER IF EXISTS trg_validate_facture_source_allocation_227 ON public.facture_source_allocations;
CREATE TRIGGER trg_validate_facture_source_allocation_227 BEFORE INSERT ON public.facture_source_allocations
FOR EACH ROW EXECUTE FUNCTION public.fn_validate_facturation_allocation_227();
DROP TRIGGER IF EXISTS trg_validate_paiement_allocation_227 ON public.paiement_allocations;
CREATE TRIGGER trg_validate_paiement_allocation_227 BEFORE INSERT ON public.paiement_allocations
FOR EACH ROW EXECUTE FUNCTION public.fn_validate_facturation_allocation_227();
DROP TRIGGER IF EXISTS trg_validate_avoir_allocation_227 ON public.avoir_source_allocations;
CREATE TRIGGER trg_validate_avoir_allocation_227 BEFORE INSERT ON public.avoir_source_allocations
FOR EACH ROW EXECUTE FUNCTION public.fn_validate_facturation_allocation_227();
DROP TRIGGER IF EXISTS trg_protect_paiement_227 ON public.paiement;
CREATE TRIGGER trg_protect_paiement_227 BEFORE UPDATE OR DELETE ON public.paiement
FOR EACH ROW EXECUTE FUNCTION public.fn_protect_paiement_227();

ALTER TABLE public.facture
  DROP COLUMN IF EXISTS settlement_status,
  DROP COLUMN IF EXISTS document_status;

COMMIT;
