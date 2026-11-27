-- Record the share of an existing producer kept for its own delivery.
BEGIN;
SET LOCAL lock_timeout='5s';
ALTER TABLE public.production_consolidations ADD COLUMN producer_own_quantity numeric(18,3);
ALTER TABLE public.production_consolidations
  ADD CONSTRAINT production_consolidations_quantity_semantics_existing_surplus
  CHECK ((quantity_semantics IN ('LEGACY_ALLOCATION_V1','GOOD_OUTPUT_V1') AND producer_own_quantity IS NULL)
    OR (quantity_semantics='EXISTING_SURPLUS_V1' AND producer_own_quantity IS NOT NULL AND producer_own_quantity >= 0)) NOT VALID;
ALTER TABLE public.production_consolidations VALIDATE CONSTRAINT production_consolidations_quantity_semantics_existing_surplus;
ALTER TABLE public.production_consolidations DROP CONSTRAINT production_consolidations_quantity_semantics_1809;

CREATE OR REPLACE FUNCTION public.fn_check_consolidation_quantity_712() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; targets uuid[]; expected numeric; allocated numeric; actual numeric; producer bigint; semantics text; own_quantity numeric;
BEGIN
  IF TG_TABLE_NAME='production_consolidations' THEN
    targets:=ARRAY[NEW.id];
  ELSIF TG_TABLE_NAME='production_consolidation_allocations' THEN
    targets:=ARRAY[NEW.consolidation_id];
  ELSIF TG_TABLE_NAME='ordres_fabrication' THEN
    SELECT array_agg(DISTINCT c.id) INTO targets
      FROM public.production_consolidations c
      LEFT JOIN public.production_consolidation_allocations a ON a.consolidation_id=c.id AND a.state='ACTIVE'
     WHERE c.state='ACTIVE' AND (c.producer_of_id=NEW.id OR a.source_of_id=NEW.id);
  ELSE
    RAISE EXCEPTION 'CONSOLIDATION_TRIGGER_SCOPE_INVALID' USING ERRCODE='23514';
  END IF;
  FOREACH target IN ARRAY COALESCE(targets,ARRAY[]::uuid[])
  LOOP
    SELECT c.surplus_quantity,o.quantite_lancee,c.producer_of_id,c.quantity_semantics,c.producer_own_quantity
      INTO expected,actual,producer,semantics,own_quantity
      FROM public.production_consolidations c JOIN public.ordres_fabrication o ON o.id=c.producer_of_id
     WHERE c.id=target AND c.state='ACTIVE';
    IF NOT FOUND THEN CONTINUE; END IF;
    SELECT COALESCE(sum(a.quantity),0) INTO allocated FROM public.production_consolidation_allocations a WHERE a.consolidation_id=target AND a.state='ACTIVE';
    IF semantics='LEGACY_ALLOCATION_V1' THEN
      IF actual<>expected+allocated THEN RAISE EXCEPTION 'CONSOLIDATION_QUANTITY_MISMATCH: quantités non conservées' USING ERRCODE='23514'; END IF;
    ELSIF semantics='GOOD_OUTPUT_V1' THEN
      SELECT expected+COALESCE(sum(source.quantite_lancee),0) INTO expected FROM public.production_consolidation_allocations allocation JOIN public.ordres_fabrication source ON source.id=allocation.source_of_id WHERE allocation.consolidation_id=target AND allocation.state='ACTIVE';
      IF actual<>expected THEN RAISE EXCEPTION 'CONSOLIDATION_GOOD_OUTPUT_LAUNCH_MISMATCH: le producteur doit conserver le brut des OF sources et le surplus physique' USING ERRCODE='23514'; END IF;
      IF EXISTS(SELECT 1 FROM public.production_consolidation_allocations allocation JOIN public.ordres_fabrication source ON source.id=allocation.source_of_id LEFT JOIN LATERAL (
        SELECT execution.result->'industrial_proposal' AS proposal FROM public.industrial_proposal_executions execution
         WHERE execution.target_type='OF' AND execution.target_id=source.id::text AND execution.status='EXECUTED' AND execution.action='MAKE'
           AND execution.result->'industrial_proposal'->>'coverage_semantics'='GOOD_OUTPUT_V1'
         ORDER BY execution.created_at DESC,execution.id DESC LIMIT 1) frozen ON true
        WHERE allocation.consolidation_id=target AND allocation.state='ACTIVE' AND (allocation.quantity<=0 OR allocation.quantity>source.quantite_lancee OR (frozen.proposal IS NOT NULL AND (
          COALESCE(frozen.proposal->>'required_good_quantity','') !~ '^[0-9]+([.][0-9]+)?$' OR COALESCE(frozen.proposal->>'expected_good_quantity','') !~ '^[0-9]+([.][0-9]+)?$' OR allocation.quantity>LEAST((frozen.proposal->>'required_good_quantity')::numeric,(frozen.proposal->>'expected_good_quantity')::numeric))))) THEN
        RAISE EXCEPTION 'CONSOLIDATION_GOOD_OUTPUT_ALLOCATION_INVALID: une affectation doit rester positive, ne pas dépasser le brut source ni le besoin figé' USING ERRCODE='23514';
      END IF;
    ELSIF semantics='EXISTING_SURPLUS_V1' THEN
      IF own_quantity+allocated+expected>actual OR allocated<=0 THEN
        RAISE EXCEPTION 'EXISTING_SURPLUS_EXCEEDED: engagements supérieurs au lancement du producteur' USING ERRCODE='23514';
      END IF;
    ELSE RAISE EXCEPTION 'CONSOLIDATION_QUANTITY_SEMANTICS_INVALID' USING ERRCODE='23514'; END IF;
    IF EXISTS(SELECT 1 FROM public.production_consolidation_allocations WHERE consolidation_id=target AND source_of_id=producer AND state='ACTIVE') THEN RAISE EXCEPTION 'CONSOLIDATION_QUANTITY_MISMATCH: un producteur ne peut pas être sa propre source' USING ERRCODE='23514'; END IF;
  END LOOP;
  RETURN NULL;
END $$;
COMMIT;
