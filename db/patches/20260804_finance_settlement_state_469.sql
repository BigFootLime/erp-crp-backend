-- Issue #469 / BUG-CERP-0007
-- Separate the immutable document lifecycle from the derived settlement state.
-- `statut` remains a backwards-compatible projection for existing consumers.
BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.facture f
    WHERE COALESCE((
      SELECT SUM(pa.amount_ttc)
      FROM public.paiement_allocations pa
      JOIN public.paiement allocated_payment ON allocated_payment.id = pa.paiement_id
      WHERE pa.facture_id = f.id
        AND allocated_payment.status NOT IN ('REJECTED','REVERSED')
        AND allocated_payment.workflow_status <> 'REVERSED'
        AND allocated_payment.reversal_of_id IS NULL
    ), 0) + COALESCE((
      SELECT SUM(p.montant)
      FROM public.paiement p
      WHERE p.facture_id = f.id
        AND p.status NOT IN ('REJECTED','REVERSED')
        AND p.workflow_status <> 'REVERSED'
        AND p.reversal_of_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM public.paiement_allocations existing_pa
          WHERE existing_pa.paiement_id = p.id
        )
    ), 0) + COALESCE((
      SELECT SUM(asa.amount_ttc)
      FROM public.avoir_source_allocations asa
      WHERE asa.facture_id = f.id AND asa.allocation_status = 'CONSUMED'
    ), 0) + COALESCE((
      SELECT SUM(a.total_ttc)
      FROM public.avoir a
      WHERE a.facture_id = f.id
        AND a.statut IN ('ISSUED','emis','emise','envoyee')
        AND NOT EXISTS (
          SELECT 1 FROM public.avoir_source_allocations existing_asa
          WHERE existing_asa.avoir_id = a.id
        )
    ), 0) > f.total_ttc
  ) THEN
    RAISE EXCEPTION '#469 migration refused: an invoice is already over-allocated';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.paiement p
    WHERE p.facture_id IS NOT NULL
      AND NOT (
        p.uuid IS NOT NULL
        AND p.code IS NOT NULL
        AND p.correlation_id IS NOT NULL
        AND p.idempotency_key IS NOT NULL
        AND p.request_hash IS NOT NULL
      )
      AND EXISTS (
        SELECT 1 FROM public.paiement_allocations pa WHERE pa.paiement_id = p.id
      )
  ) THEN
    RAISE EXCEPTION '#469 migration refused: direct legacy payment evidence was already converted to allocations';
  END IF;
END $$;

ALTER TABLE public.facture
  ADD COLUMN IF NOT EXISTS document_status text,
  ADD COLUMN IF NOT EXISTS settlement_status text;

-- Backfill only the new derived columns. Historical `statut` values are never rewritten.
ALTER TABLE public.facture DISABLE TRIGGER trg_protect_facture_immutable_227;
UPDATE public.facture f
SET document_status = CASE
      WHEN f.statut IN ('DRAFT', 'PENDING_VALIDATION', 'APPROVED', 'CANCELLED') THEN f.statut
      WHEN f.statut IN ('ISSUED', 'PARTIALLY_PAID', 'PAID') THEN 'ISSUED'
      WHEN lower(f.statut) = 'brouillon' THEN 'DRAFT'
      WHEN lower(f.statut) IN ('emis', 'emise', 'envoyee', 'partielle', 'payee') THEN 'ISSUED'
      WHEN lower(f.statut) IN ('annule', 'annulee') THEN 'CANCELLED'
      ELSE 'LEGACY'
    END,
    settlement_status = CASE
      WHEN balance.settled_ttc >= f.total_ttc AND f.total_ttc > 0 THEN 'PAID'
      WHEN balance.settled_ttc > 0 THEN 'PARTIALLY_PAID'
      ELSE 'UNPAID'
    END
FROM (
  SELECT
    invoice.id,
    (
      COALESCE((
        SELECT SUM(pa.amount_ttc)
        FROM public.paiement_allocations pa
        JOIN public.paiement allocated_payment ON allocated_payment.id = pa.paiement_id
        WHERE pa.facture_id = invoice.id
          AND allocated_payment.status NOT IN ('REJECTED','REVERSED')
          AND allocated_payment.workflow_status <> 'REVERSED'
          AND allocated_payment.reversal_of_id IS NULL
      ), 0)
      + COALESCE((
        SELECT SUM(p.montant)
        FROM public.paiement p
        WHERE p.facture_id = invoice.id
          AND p.status NOT IN ('REJECTED','REVERSED')
          AND p.workflow_status <> 'REVERSED'
          AND p.reversal_of_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM public.paiement_allocations existing_pa
            WHERE existing_pa.paiement_id = p.id
          )
      ), 0)
      + COALESCE((
        SELECT SUM(asa.amount_ttc)
        FROM public.avoir_source_allocations asa
        WHERE asa.facture_id = invoice.id AND asa.allocation_status = 'CONSUMED'
      ), 0)
      + COALESCE((
        SELECT SUM(a.total_ttc)
        FROM public.avoir a
        WHERE a.facture_id = invoice.id
          AND a.statut IN ('ISSUED','emis','emise','envoyee')
          AND NOT EXISTS (
            SELECT 1 FROM public.avoir_source_allocations existing_asa
            WHERE existing_asa.avoir_id = a.id
          )
      ), 0)
    )::numeric(18,2) AS settled_ttc
  FROM public.facture invoice
) balance
WHERE balance.id = f.id
  AND (f.document_status IS NULL OR f.settlement_status IS NULL);
ALTER TABLE public.facture ENABLE TRIGGER trg_protect_facture_immutable_227;

ALTER TABLE public.facture
  ALTER COLUMN document_status SET DEFAULT 'DRAFT',
  ALTER COLUMN document_status SET NOT NULL,
  ALTER COLUMN settlement_status SET DEFAULT 'UNPAID',
  ALTER COLUMN settlement_status SET NOT NULL;

-- Recreate the two NOT VALID compatibility constraints so a safely replayed patch
-- also repairs an earlier #469 draft definition.
ALTER TABLE public.facture DROP CONSTRAINT IF EXISTS facture_statut_469_ck;
ALTER TABLE public.avoir DROP CONSTRAINT IF EXISTS avoir_statut_469_ck;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'facture_statut_469_ck'
      AND conrelid = 'public.facture'::regclass
  ) THEN
    -- NOT VALID preserves rows outside the known vocabulary. Known historical values
    -- remain updateable; arbitrary future values are still rejected.
    ALTER TABLE public.facture ADD CONSTRAINT facture_statut_469_ck CHECK (
      statut IN (
        'DRAFT','PENDING_VALIDATION','APPROVED','ISSUED','PARTIALLY_PAID','PAID','CANCELLED',
        'brouillon','emis','emise','envoyee','partielle','payee','annule','annulee'
      )
    ) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'facture_document_status_469_ck'
      AND conrelid = 'public.facture'::regclass
  ) THEN
    ALTER TABLE public.facture ADD CONSTRAINT facture_document_status_469_ck CHECK (
      document_status IN ('DRAFT','PENDING_VALIDATION','APPROVED','ISSUED','CANCELLED','LEGACY')
    );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'facture_settlement_status_469_ck'
      AND conrelid = 'public.facture'::regclass
  ) THEN
    ALTER TABLE public.facture ADD CONSTRAINT facture_settlement_status_469_ck CHECK (
      settlement_status IN ('UNPAID','PARTIALLY_PAID','PAID')
    );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'avoir_statut_469_ck'
      AND conrelid = 'public.avoir'::regclass
  ) THEN
    ALTER TABLE public.avoir ADD CONSTRAINT avoir_statut_469_ck CHECK (
      statut IN (
        'DRAFT','PENDING_VALIDATION','APPROVED','ISSUED','CANCELLED',
        'brouillon','emis','emise','envoyee','annule','annulee'
      )
    ) NOT VALID;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS facture_document_settlement_469_idx
  ON public.facture(document_status, settlement_status, issued_at DESC);

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

  IF TG_TABLE_NAME = 'facture'
     AND OLD.document_status = 'ISSUED'
     AND NEW.document_status = 'ISSUED'
     AND OLD.statut IN (
       'ISSUED', 'PARTIALLY_PAID', 'PAID',
       'emise', 'envoyee', 'partielle', 'payee', 'emis'
     )
     AND NEW.statut = CASE
       WHEN NEW.settlement_status = 'UNPAID' THEN 'ISSUED'
       ELSE NEW.settlement_status
     END
     AND NEW.row_version = OLD.row_version + 1
     AND current_setting('cerp.finance_settlement_correlation_id', true) IS NOT NULL
     AND current_setting('cerp.finance_settlement_correlation_id', true)
         = NEW.correlation_id::text
     AND (to_jsonb(NEW)
          - 'statut' - 'document_status' - 'settlement_status'
          - 'row_version' - 'correlation_id' - 'updated_at')
         IS NOT DISTINCT FROM
         (to_jsonb(OLD)
          - 'statut' - 'document_status' - 'settlement_status'
          - 'row_version' - 'correlation_id' - 'updated_at') THEN
    RETURN NEW;
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

CREATE OR REPLACE FUNCTION public.fn_protect_facturation_child_227()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent_status text;
  parent_document_status text;
BEGIN
  IF TG_TABLE_NAME IN ('facture_ligne', 'facture_source_allocations', 'facture_echeance') THEN
    IF TG_OP = 'DELETE' THEN
      SELECT statut, document_status
      INTO parent_status, parent_document_status
      FROM public.facture
      WHERE id = OLD.facture_id;
    ELSE
      SELECT statut, document_status
      INTO parent_status, parent_document_status
      FROM public.facture
      WHERE id = NEW.facture_id;
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
    IF (parent_document_status = 'ISSUED' OR parent_status IN (
          'ISSUED', 'PARTIALLY_PAID', 'PAID',
          'emis', 'emise', 'envoyee', 'partielle', 'payee'
        ))
       AND NEW.amount_allocated >= OLD.amount_allocated
       AND NEW.amount_allocated <= NEW.amount_due
       AND NEW.status = CASE
         WHEN NEW.amount_allocated >= NEW.amount_due THEN 'PAID'
         WHEN NEW.amount_allocated > 0 THEN 'PARTIALLY_PAID'
         ELSE OLD.status
       END
       AND (to_jsonb(NEW) - 'amount_allocated' - 'status')
           IS NOT DISTINCT FROM
           (to_jsonb(OLD) - 'amount_allocated' - 'status') THEN
      RETURN NEW;
    END IF;
  END IF;

  IF parent_document_status = 'ISSUED' OR parent_status IN (
    'ISSUED', 'PARTIALLY_PAID', 'PAID', 'CANCELLED',
    'emise', 'envoyee', 'partielle', 'payee', 'annulee', 'emis', 'annule'
  ) THEN
    RAISE EXCEPTION 'children of issued or cancelled finance evidence are immutable' USING ERRCODE = '55000';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

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

    SELECT (
      COALESCE((
        SELECT SUM(pa.amount_ttc)
        FROM public.paiement_allocations pa
        JOIN public.paiement allocated_payment ON allocated_payment.id = pa.paiement_id
        WHERE pa.facture_id = NEW.facture_id
          AND allocated_payment.status NOT IN ('REJECTED','REVERSED')
          AND allocated_payment.workflow_status <> 'REVERSED'
          AND allocated_payment.reversal_of_id IS NULL
      ), 0)
      + COALESCE((
        SELECT SUM(p.montant)
        FROM public.paiement p
        WHERE p.facture_id = NEW.facture_id
          AND p.id <> NEW.paiement_id
          AND p.status NOT IN ('REJECTED','REVERSED')
          AND p.workflow_status <> 'REVERSED'
          AND p.reversal_of_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM public.paiement_allocations existing_pa
            WHERE existing_pa.paiement_id = p.id
          )
      ), 0)
      + COALESCE((
        SELECT SUM(asa.amount_ttc)
        FROM public.avoir_source_allocations asa
        WHERE asa.facture_id = NEW.facture_id
          AND asa.allocation_status = 'CONSUMED'
      ), 0)
      + COALESCE((
        SELECT SUM(a.total_ttc)
        FROM public.avoir a
        WHERE a.facture_id = NEW.facture_id
          AND a.statut IN ('ISSUED','emis','emise','envoyee')
          AND NOT EXISTS (
            SELECT 1 FROM public.avoir_source_allocations existing_asa
            WHERE existing_asa.avoir_id = a.id
          )
      ), 0)
    )::numeric(18,2)
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

    SELECT (
      COALESCE((
        SELECT SUM(pa.amount_ttc)
        FROM public.paiement_allocations pa
        JOIN public.paiement allocated_payment ON allocated_payment.id = pa.paiement_id
        WHERE pa.facture_id = NEW.facture_id
          AND allocated_payment.status NOT IN ('REJECTED','REVERSED')
          AND allocated_payment.workflow_status <> 'REVERSED'
          AND allocated_payment.reversal_of_id IS NULL
      ), 0)
      + COALESCE((
        SELECT SUM(p.montant)
        FROM public.paiement p
        WHERE p.facture_id = NEW.facture_id
          AND p.status NOT IN ('REJECTED','REVERSED')
          AND p.workflow_status <> 'REVERSED'
          AND p.reversal_of_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM public.paiement_allocations existing_pa
            WHERE existing_pa.paiement_id = p.id
          )
      ), 0)
      + COALESCE((
        SELECT SUM(asa.amount_ttc)
        FROM public.avoir_source_allocations asa
        WHERE asa.facture_id = NEW.facture_id
          AND asa.allocation_status = 'CONSUMED'
          AND asa.id IS DISTINCT FROM NEW.id
      ), 0)
      + COALESCE((
        SELECT SUM(a.total_ttc)
        FROM public.avoir a
        WHERE a.facture_id = NEW.facture_id
          AND a.statut IN ('ISSUED','emis','emise','envoyee')
          AND NOT EXISTS (
            SELECT 1 FROM public.avoir_source_allocations existing_asa
            WHERE existing_asa.avoir_id = a.id
          )
      ), 0)
    )::numeric(18,2)
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

CREATE OR REPLACE FUNCTION public.fn_protect_paiement_227()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  has_allocations boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM public.paiement_allocations WHERE paiement_id = OLD.id
  ) INTO has_allocations;

  IF OLD.uuid IS NULL AND (OLD.facture_id IS NOT NULL OR has_allocations) THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'direct legacy payment evidence cannot be deleted' USING ERRCODE = '55000';
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.uuid IS DISTINCT FROM OLD.uuid
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
       OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.status IS DISTINCT FROM OLD.status
       OR NEW.workflow_status IS DISTINCT FROM OLD.workflow_status
       OR NEW.reversal_of_id IS DISTINCT FROM OLD.reversal_of_id THEN
      RAISE EXCEPTION 'direct legacy payment evidence is immutable' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.uuid IS NULL THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'recorded payment evidence cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.uuid IS DISTINCT FROM OLD.uuid
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

DROP TRIGGER IF EXISTS trg_validate_avoir_allocation_227 ON public.avoir_source_allocations;
CREATE TRIGGER trg_validate_avoir_allocation_227
BEFORE INSERT OR UPDATE ON public.avoir_source_allocations
FOR EACH ROW EXECUTE FUNCTION public.fn_validate_facturation_allocation_227();

COMMENT ON COLUMN public.facture.document_status IS
  'Authoritative document lifecycle. ISSUED remains immutable after legal emission.';
COMMENT ON COLUMN public.facture.settlement_status IS
  'Derived from modern allocations plus non-duplicated direct legacy evidence: UNPAID, PARTIALLY_PAID, PAID.';

COMMIT;
