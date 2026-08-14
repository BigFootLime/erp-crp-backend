-- SOL-28 rollback is permitted only before any subscription, delivery, receipt
-- or audit evidence exists. Once used, disable the worker and preserve proof.
BEGIN;

DO $rollback_guard$
DECLARE
  evidence_count bigint := 0;
BEGIN
  IF to_regclass('public.api_webhook_subscriptions') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.api_webhook_subscriptions' INTO evidence_count;
  END IF;
  IF evidence_count = 0 AND to_regclass('public.api_webhook_events') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.api_webhook_events' INTO evidence_count;
  END IF;
  IF evidence_count = 0 AND to_regclass('public.api_webhook_deliveries') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.api_webhook_deliveries' INTO evidence_count;
  END IF;
  IF evidence_count = 0 AND to_regclass('public.api_webhook_command_receipts') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.api_webhook_command_receipts' INTO evidence_count;
  END IF;
  IF evidence_count = 0 AND to_regclass('public.api_webhook_audit_events') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.api_webhook_audit_events' INTO evidence_count;
  END IF;
  IF evidence_count > 0 THEN
    RAISE EXCEPTION 'SOL-28 rollback refused: webhook business or audit evidence exists';
  END IF;
END
$rollback_guard$;

DROP TRIGGER IF EXISTS trg_api_webhook_attempts_immutable_sol28 ON public.api_webhook_delivery_attempts;
DROP TRIGGER IF EXISTS trg_api_webhook_receipts_immutable_sol28 ON public.api_webhook_command_receipts;
DROP TRIGGER IF EXISTS trg_api_webhook_audit_immutable_sol28 ON public.api_webhook_audit_events;
DROP FUNCTION IF EXISTS public.fn_api_webhook_evidence_immutable_sol28();
DROP TABLE IF EXISTS public.api_webhook_delivery_attempts;
DROP TABLE IF EXISTS public.api_webhook_command_receipts;
DROP TABLE IF EXISTS public.api_webhook_audit_events;
DROP TABLE IF EXISTS public.api_webhook_deliveries;
DROP TABLE IF EXISTS public.api_webhook_events;
DROP TABLE IF EXISTS public.api_webhook_subscriptions;
DROP TABLE IF EXISTS public.api_webhook_ingestion_state;

COMMIT;

DO $verify_rollback$
BEGIN
  IF to_regclass('public.api_webhook_subscriptions') IS NOT NULL
     OR to_regclass('public.api_webhook_deliveries') IS NOT NULL
     OR to_regclass('public.api_webhook_audit_events') IS NOT NULL THEN
    RAISE EXCEPTION 'SOL-28 rollback verification failed';
  END IF;
END
$verify_rollback$;
