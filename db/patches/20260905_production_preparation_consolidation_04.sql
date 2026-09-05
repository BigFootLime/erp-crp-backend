BEGIN;
CREATE OR REPLACE FUNCTION public.fn_check_consolidation_quantity_712() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; expected numeric; allocated numeric; actual numeric; producer bigint;
BEGIN
  IF TG_TABLE_NAME='production_consolidations' THEN target:=NEW.id; ELSE target:=NEW.consolidation_id; END IF;
  SELECT c.surplus_quantity,o.quantite_lancee,c.producer_of_id INTO expected,actual,producer
    FROM public.production_consolidations c JOIN public.ordres_fabrication o ON o.id=c.producer_of_id WHERE c.id=target AND c.state='ACTIVE';
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT COALESCE(sum(quantity),0) INTO allocated FROM public.production_consolidation_allocations WHERE consolidation_id=target AND state='ACTIVE';
  IF actual<>expected+allocated OR EXISTS(SELECT 1 FROM public.production_consolidation_allocations WHERE consolidation_id=target AND source_of_id=producer) THEN
    RAISE EXCEPTION 'CONSOLIDATION_QUANTITY_MISMATCH: quantités non conservées' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
COMMIT;
