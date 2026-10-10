-- Guarded schema rollback. Once a reservation supplies multiple historical
-- allocations, restoring global uniqueness would erase or invalidate evidence.
BEGIN;
SET LOCAL lock_timeout='5s';
LOCK TABLE public.bon_livraison_ligne_allocations IN SHARE ROW EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.bon_livraison_ligne_allocations
      WHERE reservation_id IS NOT NULL GROUP BY reservation_id HAVING count(*)>1) THEN
    RAISE EXCEPTION 'Cannot restore global reservation uniqueness after partial deliveries; keep #1124 and roll forward';
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS bl_allocations_reservation_226_uq
  ON public.bon_livraison_ligne_allocations(reservation_id) WHERE reservation_id IS NOT NULL;
DROP INDEX IF EXISTS public.bl_allocations_line_reservation_1124_uq;
COMMIT;
