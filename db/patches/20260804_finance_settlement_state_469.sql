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
      SELECT SUM(pa.amount_ttc) FROM public.paiement_allocations pa WHERE pa.facture_id = f.id
    ), 0) + COALESCE((
      SELECT SUM(p.montant)
      FROM public.paiement p
      WHERE p.facture_id = f.id
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
      WHEN f.statut = 'PAID' OR lower(f.statut) = 'payee' THEN 'PAID'
      WHEN f.statut = 'PARTIALLY_PAID' OR lower(f.statut) = 'partielle' THEN 'PARTIALLY_PAID'
      ELSE 'UNPAID'
    END
FROM (
  SELECT
    invoice.id,
    (
      COALESCE((
        SELECT SUM(pa.amount_ttc)
        FROM public.paiement_allocations pa
        WHERE pa.facture_id = invoice.id
      ), 0)
      + COALESCE((
        SELECT SUM(p.montant)
        FROM public.paiement p
        WHERE p.facture_id = invoice.id
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

COMMENT ON COLUMN public.facture.document_status IS
  'Authoritative document lifecycle. ISSUED remains immutable after legal emission.';
COMMENT ON COLUMN public.facture.settlement_status IS
  'Derived from modern allocations plus non-duplicated direct legacy evidence: UNPAID, PARTIALLY_PAID, PAID.';

COMMIT;
