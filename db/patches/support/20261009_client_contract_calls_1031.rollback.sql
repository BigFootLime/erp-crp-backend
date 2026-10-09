-- Unused schema only. A used call ledger and its canonical orders must be retained.
BEGIN;
LOCK TABLE public.client_contract_calls,public.client_contract_call_lines IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM public.client_contract_calls) OR EXISTS(SELECT 1 FROM public.client_contract_call_lines) THEN
    RAISE EXCEPTION 'Calls already recorded: retain schema and restore compatible runtime'; END IF;
END $$;
DROP TABLE public.client_contract_call_lines;
DROP TABLE public.client_contract_calls;
COMMIT;
