\set ON_ERROR_STOP on

-- Guarded rollback for new #227 tables/triggers on an empty installation only.
-- Additive columns are intentionally preserved because IF NOT EXISTS cannot
-- prove they were introduced by this patch. Never run automatically.
BEGIN;
DO $$
BEGIN
  IF current_database() <> 'cerp_test' THEN
    RAISE EXCEPTION '#227 rollback is restricted to cerp_test';
  END IF;
  IF EXISTS (SELECT 1 FROM public.facture_source_allocations)
     OR EXISTS (SELECT 1 FROM public.avoir_source_allocations)
     OR EXISTS (SELECT 1 FROM public.facture_echeance)
     OR EXISTS (SELECT 1 FROM public.paiement_allocations)
     OR EXISTS (SELECT 1 FROM public.finance_command_receipts)
     OR EXISTS (SELECT 1 FROM public.finance_event_log)
     OR EXISTS (SELECT 1 FROM public.finance_document_versions)
     OR EXISTS (SELECT 1 FROM public.facture WHERE statut = 'ISSUED' OR legal_number IS NOT NULL)
  THEN
    RAISE EXCEPTION '#227 rollback refused: Finance evidence exists';
  END IF;
END $$;

DROP TRIGGER IF EXISTS trg_protect_facture_immutable_227 ON public.facture;
DROP TRIGGER IF EXISTS trg_protect_avoir_immutable_227 ON public.avoir;
DROP TRIGGER IF EXISTS trg_protect_facture_ligne_227 ON public.facture_ligne;
DROP TRIGGER IF EXISTS trg_protect_avoir_ligne_227 ON public.avoir_ligne;
DROP TRIGGER IF EXISTS trg_protect_facture_source_227 ON public.facture_source_allocations;
DROP TRIGGER IF EXISTS trg_protect_facture_echeance_227 ON public.facture_echeance;
DROP TRIGGER IF EXISTS trg_protect_avoir_source_227 ON public.avoir_source_allocations;
DROP TRIGGER IF EXISTS trg_protect_paiement_227 ON public.paiement;
DROP TRIGGER IF EXISTS trg_validate_facture_source_allocation_227 ON public.facture_source_allocations;
DROP TRIGGER IF EXISTS trg_validate_paiement_allocation_227 ON public.paiement_allocations;
DROP TRIGGER IF EXISTS trg_validate_avoir_allocation_227 ON public.avoir_source_allocations;
DROP TRIGGER IF EXISTS trg_protect_finance_command_receipts ON public.finance_command_receipts;
DROP TRIGGER IF EXISTS trg_protect_finance_event_log ON public.finance_event_log;
DROP TRIGGER IF EXISTS trg_protect_finance_document_versions ON public.finance_document_versions;
DROP TABLE IF EXISTS public.finance_document_versions;
DROP TABLE IF EXISTS public.finance_event_log;
DROP TABLE IF EXISTS public.finance_command_receipts;
DROP TABLE IF EXISTS public.paiement_allocations;
DROP TABLE IF EXISTS public.avoir_source_allocations;
DROP TABLE IF EXISTS public.facture_source_allocations;
DROP TABLE IF EXISTS public.facture_echeance;
DROP TABLE IF EXISTS public.finance_legal_sequences;
DROP TABLE IF EXISTS public.finance_billing_policies;
DROP FUNCTION IF EXISTS public.fn_protect_facturation_evidence_227();
DROP FUNCTION IF EXISTS public.fn_protect_paiement_227();
DROP FUNCTION IF EXISTS public.fn_validate_facturation_allocation_227();
DROP FUNCTION IF EXISTS public.fn_protect_facturation_child_227();
DROP FUNCTION IF EXISTS public.fn_protect_facturation_immutable_227();
COMMIT;
