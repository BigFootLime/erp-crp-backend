\set ON_ERROR_STOP on
-- Read-only: a legacy group must already satisfy its original invariant before
-- this additive marker makes future good-output groups available.
DO $$ BEGIN
  IF to_regclass('public.production_consolidations') IS NULL
    OR to_regclass('public.production_consolidation_allocations') IS NULL
    OR to_regclass('public.industrial_proposal_executions') IS NULL THEN
    RAISE EXCEPTION 'Consolidation good-output prerequisite is missing';
  END IF;
  IF EXISTS(
    SELECT 1 FROM public.production_consolidations c
    JOIN public.ordres_fabrication o ON o.id=c.producer_of_id
    WHERE c.state='ACTIVE'
      AND o.quantite_lancee<>c.surplus_quantity+COALESCE((
        SELECT sum(a.quantity) FROM public.production_consolidation_allocations a
        WHERE a.consolidation_id=c.id AND a.state='ACTIVE'),0)
  ) THEN
    RAISE EXCEPTION 'Existing consolidation quantity conservation failed; reconcile before migration';
  END IF;
END $$;
SELECT current_database() AS database_name, 'Consolidation good-output preflight passed (read-only)' AS result;
