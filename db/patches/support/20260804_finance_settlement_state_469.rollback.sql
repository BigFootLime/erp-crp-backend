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

ALTER TABLE public.facture
  DROP COLUMN IF EXISTS settlement_status,
  DROP COLUMN IF EXISTS document_status;

COMMIT;
