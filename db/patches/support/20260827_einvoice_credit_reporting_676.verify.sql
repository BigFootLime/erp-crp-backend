DO $verify$
BEGIN
  IF to_regclass('public.einvoice_reporting_periods') IS NULL
     OR to_regclass('public.einvoice_reporting_transactions') IS NULL
     OR to_regclass('public.einvoice_reporting_payments') IS NULL
     OR to_regclass('public.einvoice_reporting_receipts') IS NULL
     OR to_regclass('public.einvoice_reporting_command_receipts') IS NULL THEN
    RAISE EXCEPTION 'EINVOICE-676 reporting tables are incomplete';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgname LIKE 'einvoice_reporting_%append_only_676' AND NOT tgisinternal) <> 2 THEN
    RAISE EXCEPTION 'EINVOICE-676 append-only evidence triggers are incomplete';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.avoir
    WHERE regulatory_snapshot IS NOT NULL
      AND (billing_frame_code IS NULL OR transaction_scope IS NULL)
  ) THEN
    RAISE EXCEPTION 'EINVOICE-676 partial credit-note regulatory snapshots exist';
  END IF;
END
$verify$;

SELECT status, count(*) FROM public.einvoice_reporting_transactions GROUP BY status ORDER BY status;
SELECT status, count(*) FROM public.einvoice_reporting_payments GROUP BY status ORDER BY status;
