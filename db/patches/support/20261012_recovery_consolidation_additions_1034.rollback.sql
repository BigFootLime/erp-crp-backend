-- Restore the matching previous backend. Never delete a completed addition.
BEGIN;
SET LOCAL lock_timeout='5s';
LOCK TABLE public.production_recovery_consolidation_additions IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM public.production_recovery_consolidation_additions) THEN
    RAISE EXCEPTION 'Retain recovery grouping decisions; use a forward reconciliation';
  END IF;
END $$;
CREATE OR REPLACE FUNCTION public.fn_guard_consolidation_producer_712() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.quantite_lancee IS DISTINCT FROM OLD.quantite_lancee AND EXISTS(SELECT 1 FROM public.production_consolidations WHERE producer_of_id=NEW.id AND state='ACTIVE') THEN
    RAISE EXCEPTION 'CONSOLIDATION_QUANTITY_LOCKED: dissoudre le regroupement avant de modifier son besoin' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TABLE public.production_recovery_consolidation_additions;
DROP FUNCTION public.fn_recovery_consolidation_addition_1034();
DROP FUNCTION public.fn_recovery_consolidation_addition_complete_1034();
COMMIT;
