\set ON_ERROR_STOP on

-- Disposable environments only. Operational evidence is never deleted.
-- Invoke in one psql session with:
--   -c "SET cerp.allow_sol17_rollback='SOL-17'" -f <this-file>
BEGIN;

DO $guard$
DECLARE
  expected_sha256 constant text := '9da8fc1d7a71a5cf1133995de85d2c2680eeec5f7d7ffbcaa826351d8f35e97e';
  registered_sha256 text;
BEGIN
  IF current_database() !~* '(test|dev|local|sandbox)' THEN
    RAISE EXCEPTION 'SOL-17 rollback: only a disposable dev/test database is allowed';
  END IF;
  IF current_setting('cerp.allow_sol17_rollback',true) IS DISTINCT FROM 'SOL-17' THEN
    RAISE EXCEPTION 'SOL-17 rollback: explicit session token is missing';
  END IF;
  SELECT sha256 INTO registered_sha256
  FROM public.cerp_schema_migrations
  WHERE filename='20260812_commercial_reliability_sol17.sql'
  FOR UPDATE;
  IF registered_sha256 IS DISTINCT FROM expected_sha256 THEN
    RAISE EXCEPTION 'SOL-17 rollback: migration ledger checksum is missing or unexpected';
  END IF;
  IF (SELECT COUNT(*) FROM public.commercial_quote_events)>0
     OR (SELECT COUNT(*) FROM public.commercial_order_cancellations)>0
     OR (SELECT COUNT(*) FROM public.commercial_command_receipts)>0 THEN
    RAISE EXCEPTION 'SOL-17 rollback: commercial evidence exists; rollback refused';
  END IF;
END
$guard$;

DROP TRIGGER commercial_quote_events_append_only ON public.commercial_quote_events;
DROP TRIGGER commercial_order_cancellations_append_only ON public.commercial_order_cancellations;
DROP TRIGGER commercial_command_receipts_append_only ON public.commercial_command_receipts;
DROP TABLE public.commercial_command_receipts;
DROP TABLE public.commercial_order_cancellations;
DROP TABLE public.commercial_quote_events;
DROP FUNCTION public.fn_commercial_evidence_append_only();

DELETE FROM public.cerp_schema_migrations
WHERE filename='20260812_commercial_reliability_sol17.sql';

COMMIT;
