-- Roll back the #469 schema contract. Derived columns are removed; historical rows are untouched.
BEGIN;

DO $$
BEGIN
  IF current_database() <> 'cerp_test' THEN
    RAISE EXCEPTION '#469 rollback is restricted to cerp_test';
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

ALTER TABLE public.facture
  DROP COLUMN IF EXISTS settlement_status,
  DROP COLUMN IF EXISTS document_status;

COMMIT;
