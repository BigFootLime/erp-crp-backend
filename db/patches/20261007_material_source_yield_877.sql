-- #877. Observed per-source yields; historical proofs remain unknown.
BEGIN;
ALTER TABLE public.production_material_debit_sources ADD COLUMN IF NOT EXISTS yield_good integer;
ALTER TABLE public.production_material_debit_sources ADD COLUMN IF NOT EXISTS yield_scrap integer;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.production_material_debit_sources'::regclass AND conname='material_source_yield_pair') THEN
    ALTER TABLE public.production_material_debit_sources ADD CONSTRAINT material_source_yield_pair CHECK (
      (yield_good IS NULL AND yield_scrap IS NULL) OR
      (yield_good IS NOT NULL AND yield_scrap IS NOT NULL AND actual_qty IS NOT NULL
       AND abs(yield_good::bigint)<=1000000000 AND abs(yield_scrap::bigint)<=1000000000
       AND ((actual_qty>0 AND yield_good>=0 AND yield_scrap>=0) OR
            (actual_qty<0 AND yield_good<=0 AND yield_scrap<=0))));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.guard_material_source_yield() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE expected_good numeric; expected_scrap numeric; original uuid;
BEGIN
  SELECT q.qty_good,q.qty_scrap,d.compensates_id INTO expected_good,expected_scrap,original
    FROM public.production_material_debits d JOIN public.production_quantity_declarations q ON q.id=d.declaration_id
    WHERE d.id=NEW.debit_id;
  -- Old corrections contain no invented allocation, and remain nullable.
  IF NOT EXISTS(SELECT 1 FROM public.production_material_debit_sources WHERE debit_id=NEW.debit_id AND yield_good IS NOT NULL) THEN
    IF original IS NOT NULL AND EXISTS(SELECT 1 FROM public.production_material_debit_sources WHERE debit_id=original AND yield_good IS NOT NULL) THEN
      RAISE EXCEPTION 'Known material source yield cannot be removed by a correction' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF EXISTS(SELECT 1 FROM public.production_material_debit_sources WHERE debit_id=NEW.debit_id AND yield_good IS NULL) THEN
    RAISE EXCEPTION 'Material source yield must cover every source of this debit' USING ERRCODE='23514';
  END IF;
  IF expected_good IS NULL OR expected_scrap IS NULL THEN
    RAISE EXCEPTION 'Material source yield declaration is missing' USING ERRCODE='23514';
  END IF;
  IF EXISTS(SELECT 1 FROM public.production_material_debit_sources WHERE debit_id=NEW.debit_id
    GROUP BY need_id HAVING sum(yield_good)<>expected_good OR sum(yield_scrap)<>expected_scrap) THEN
    RAISE EXCEPTION 'Material source yield totals differ from the declaration for a material need' USING ERRCODE='23514';
  END IF;
  IF original IS NOT NULL AND ((SELECT count(*) FROM public.production_material_debit_sources WHERE debit_id=original) <>
    (SELECT count(*) FROM public.production_material_debit_sources WHERE debit_id=NEW.debit_id) OR EXISTS (
    SELECT 1 FROM public.production_material_debit_sources corrected
    LEFT JOIN public.production_material_debit_sources previous ON previous.debit_id=original
      AND previous.reservation_id=corrected.reservation_id AND previous.need_id=corrected.need_id
    WHERE corrected.debit_id=NEW.debit_id AND
      (previous.debit_id IS NULL OR corrected.yield_good IS DISTINCT FROM -previous.yield_good
       OR corrected.yield_scrap IS DISTINCT FROM -previous.yield_scrap))) THEN
    RAISE EXCEPTION 'Material source yield correction must invert the original proof' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS production_material_source_yield_guard ON public.production_material_debit_sources;
CREATE CONSTRAINT TRIGGER production_material_source_yield_guard
  AFTER INSERT ON public.production_material_debit_sources DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.guard_material_source_yield();
ALTER FUNCTION public.guard_material_source_yield() OWNER TO cerp_app;
COMMIT;
