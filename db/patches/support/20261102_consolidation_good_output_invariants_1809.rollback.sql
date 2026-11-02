\set ON_ERROR_STOP on
-- Safe only before any group adopts the new semantic; existing historical
-- groups remain untouched and the registry row is owned by the runner.
BEGIN;
SET LOCAL lock_timeout='5s';
LOCK TABLE public.production_consolidations,public.production_consolidation_allocations,public.ordres_fabrication IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM public.production_consolidations WHERE quantity_semantics='GOOD_OUTPUT_V1') THEN
    RAISE EXCEPTION 'Retain good-output consolidations; use a forward reconciliation';
  END IF;
END $$;
DROP TRIGGER IF EXISTS check_consolidation_quantity_sources_1809 ON public.ordres_fabrication;
ALTER TABLE public.production_consolidations DROP CONSTRAINT IF EXISTS production_consolidations_quantity_semantics_1809;
ALTER TABLE public.production_consolidations DROP COLUMN IF EXISTS quantity_semantics;
CREATE OR REPLACE FUNCTION public.fn_check_consolidation_quantity_712() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; expected numeric; allocated numeric; actual numeric; producer bigint;
BEGIN
  IF TG_TABLE_NAME='production_consolidations' THEN target:=NEW.id; ELSE target:=NEW.consolidation_id; END IF;
  SELECT c.surplus_quantity,o.quantite_lancee,c.producer_of_id INTO expected,actual,producer FROM public.production_consolidations c JOIN public.ordres_fabrication o ON o.id=c.producer_of_id WHERE c.id=target AND c.state='ACTIVE';
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT COALESCE(sum(quantity),0) INTO allocated FROM public.production_consolidation_allocations WHERE consolidation_id=target AND state='ACTIVE';
  IF actual<>expected+allocated OR EXISTS(SELECT 1 FROM public.production_consolidation_allocations WHERE consolidation_id=target AND source_of_id=producer) THEN RAISE EXCEPTION 'CONSOLIDATION_QUANTITY_MISMATCH: quantités non conservées' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
COMMIT;
