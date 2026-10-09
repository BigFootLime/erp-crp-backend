-- Only an entirely unused catalog can be removed; retain all used definitions and evidence.
BEGIN;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM public.client_contract_events) OR EXISTS(SELECT 1 FROM public.client_contracts)
    OR EXISTS(SELECT 1 FROM public.client_contract_lines) THEN RAISE EXCEPTION 'Contract catalog already used: retain schema and restore compatible runtime'; END IF;
END $$;
DROP TABLE public.client_contract_events;
DROP TABLE public.client_contract_lines;
DROP TABLE public.client_contracts;
COMMIT;
