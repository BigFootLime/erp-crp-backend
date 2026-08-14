\set ON_ERROR_STOP on

DO $guard$
BEGIN
  IF current_database() !~ '(^|_)test($|_)|isolated|sandbox' THEN
    RAISE EXCEPTION 'SOL-26 rollback is allowed only on an isolated/test database; restore the pre-migration backup in production';
  END IF;
  IF EXISTS (SELECT 1 FROM public.einvoice_documents LIMIT 1) THEN
    RAISE EXCEPTION 'SOL-26 rollback refused because electronic-invoice evidence exists; restore the backup instead';
  END IF;
END
$guard$;

BEGIN;
DROP TABLE IF EXISTS public.einvoice_command_receipts;
DROP TABLE IF EXISTS public.einvoice_provider_events;
DROP TABLE IF EXISTS public.einvoice_submission_attempts;
DROP TABLE IF EXISTS public.einvoice_documents;
DROP TABLE IF EXISTS public.einvoice_provider_connections;
DROP FUNCTION IF EXISTS public.fn_einvoice_evidence_append_only_sol26();
COMMIT;
