-- Rollback is permitted only before any portal identity, publication or audit
-- evidence exists. Once used, disable the routes and preserve the evidence.
BEGIN;

DO $rollback_guard$
DECLARE
  evidence bigint := 0;
BEGIN
  IF to_regclass('public.client_portal_accounts') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.client_portal_accounts' INTO evidence;
  END IF;
  IF evidence = 0 AND to_regclass('public.client_portal_publications') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.client_portal_publications' INTO evidence;
  END IF;
  IF evidence = 0 AND to_regclass('public.client_portal_audit_events') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.client_portal_audit_events' INTO evidence;
  END IF;
  IF evidence > 0 THEN
    RAISE EXCEPTION 'SOL-29 rollback refused: portal identity, publication or audit evidence exists';
  END IF;
END
$rollback_guard$;

DROP VIEW IF EXISTS public.client_portal_invoices_v;
DROP VIEW IF EXISTS public.client_portal_deliveries_v;
DROP VIEW IF EXISTS public.client_portal_orders_v;
DROP TRIGGER IF EXISTS trg_client_portal_ack_tenant_guard_sol29 ON public.client_portal_acknowledgements;
DROP TRIGGER IF EXISTS trg_client_portal_receipts_immutable_sol29 ON public.client_portal_command_receipts;
DROP TRIGGER IF EXISTS trg_client_portal_ack_immutable_sol29 ON public.client_portal_acknowledgements;
DROP TRIGGER IF EXISTS trg_client_portal_audit_immutable_sol29 ON public.client_portal_audit_events;
DROP TABLE IF EXISTS public.client_portal_auth_attempts;
DROP TABLE IF EXISTS public.client_portal_audit_events;
DROP TABLE IF EXISTS public.client_portal_acknowledgements;
DROP TABLE IF EXISTS public.client_portal_publications;
DROP TABLE IF EXISTS public.client_portal_command_receipts;
DROP TABLE IF EXISTS public.client_portal_tokens;
DROP TABLE IF EXISTS public.client_portal_accounts;
DROP FUNCTION IF EXISTS public.fn_client_portal_ack_tenant_guard_sol29();
DROP FUNCTION IF EXISTS public.fn_client_portal_evidence_immutable_sol29();

COMMIT;

DO $verify_rollback$
BEGIN
  IF to_regclass('public.client_portal_accounts') IS NOT NULL
     OR to_regclass('public.client_portal_publications') IS NOT NULL
     OR to_regclass('public.client_portal_audit_events') IS NOT NULL THEN
    RAISE EXCEPTION 'SOL-29 rollback verification failed';
  END IF;
END
$verify_rollback$;
