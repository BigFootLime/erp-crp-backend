\set ON_ERROR_STOP on
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.accounting_export_batches LIMIT 1) THEN
    RAISE EXCEPTION 'SOL-27 rollback refused: accounting export evidence exists; restore the pre-migration backup or retain the additive schema';
  END IF;
END $$;

BEGIN;
DROP TRIGGER IF EXISTS trg_protect_accounting_entries_sol27 ON public.accounting_export_entries;
DROP TRIGGER IF EXISTS trg_protect_accounting_sources_sol27 ON public.accounting_export_batch_sources;
DROP TRIGGER IF EXISTS trg_protect_accounting_batch_sol27 ON public.accounting_export_batches;
DROP FUNCTION IF EXISTS public.fn_protect_accounting_export_sol27();
DROP TABLE IF EXISTS public.accounting_export_command_receipts;
DROP TABLE IF EXISTS public.accounting_export_source_claims;
DROP TABLE IF EXISTS public.accounting_export_entries;
DROP TABLE IF EXISTS public.accounting_export_batch_sources;
DROP TABLE IF EXISTS public.accounting_export_batches;
DROP TABLE IF EXISTS public.accounting_export_mapping_versions;
COMMIT;

-- fn_protect_facturation_immutable_227 intentionally remains on the safe JSON-access
-- implementation: rolling back the SOL-27 tables must not reintroduce the pre-existing
-- credit-note emission failure fixed during the isolated rehearsal.
