DO $rollback$
BEGIN
  IF current_database() !~* '(test|isolated|scratch)' THEN
    RAISE EXCEPTION 'EINVOICE-676 rollback is allowed only on an isolated/test database';
  END IF;
  IF to_regclass('public.einvoice_reporting_receipts') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.einvoice_reporting_receipts) THEN
    RAISE EXCEPTION 'EINVOICE-676 rollback refused because reporting evidence exists';
  END IF;
  IF EXISTS (SELECT 1 FROM public.avoir WHERE regulatory_snapshot IS NOT NULL) THEN
    RAISE EXCEPTION 'EINVOICE-676 rollback refused because qualified credit notes exist';
  END IF;
END
$rollback$;

DROP TABLE IF EXISTS public.einvoice_reporting_command_receipts;
DROP TABLE IF EXISTS public.einvoice_reporting_receipts;
DROP TABLE IF EXISTS public.einvoice_reporting_payments;
DROP TABLE IF EXISTS public.einvoice_reporting_transactions;
DROP TABLE IF EXISTS public.einvoice_reporting_periods;
DROP FUNCTION IF EXISTS public.fn_einvoice_reporting_evidence_append_only_676();
ALTER TABLE public.avoir DROP CONSTRAINT IF EXISTS avoir_billing_frame_676_fk;
ALTER TABLE public.avoir DROP CONSTRAINT IF EXISTS avoir_regulatory_fields_676_ck;
ALTER TABLE public.avoir DROP COLUMN IF EXISTS regulatory_snapshot;
ALTER TABLE public.avoir DROP COLUMN IF EXISTS transaction_scope;
ALTER TABLE public.avoir DROP COLUMN IF EXISTS operation_category;
ALTER TABLE public.avoir DROP COLUMN IF EXISTS billing_frame_code;
ALTER TABLE public.avoir DROP COLUMN IF EXISTS billing_frame_catalog_version;
