-- #1124: a reservation can supply successive partial delivery notes.
-- Keep historical allocations. Duplicate allocation of one reservation to the
-- same delivery line is still rejected; cart locks/counters enforce stock limits.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
LOCK TABLE public.bon_livraison_ligne_allocations IN SHARE ROW EXCLUSIVE MODE;
DO $$
BEGIN
  IF to_regclass('public.bl_allocations_reservation_226_uq') IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM pg_index i
        WHERE i.indexrelid=to_regclass('public.bl_allocations_reservation_226_uq')
          AND i.indrelid='public.bon_livraison_ligne_allocations'::regclass
          AND i.indisunique AND i.indisvalid AND i.indnkeyatts=1
          AND pg_get_indexdef(i.indexrelid,1,true)='reservation_id'
          AND pg_get_expr(i.indpred,i.indrelid)='(reservation_id IS NOT NULL)') THEN
    RAISE EXCEPTION 'Unexpected legacy reservation index; stop #1124 for review';
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS bl_allocations_line_reservation_1124_uq
  ON public.bon_livraison_ligne_allocations(bon_livraison_ligne_id, reservation_id)
  WHERE reservation_id IS NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_index i
      WHERE i.indexrelid=to_regclass('public.bl_allocations_line_reservation_1124_uq')
        AND i.indrelid='public.bon_livraison_ligne_allocations'::regclass
        AND i.indisunique AND i.indisvalid AND i.indnkeyatts=2
        AND pg_get_indexdef(i.indexrelid,1,true)='bon_livraison_ligne_id'
        AND pg_get_indexdef(i.indexrelid,2,true)='reservation_id'
        AND pg_get_expr(i.indpred,i.indrelid)='(reservation_id IS NOT NULL)') THEN
    RAISE EXCEPTION 'Unexpected scoped reservation index; stop #1124 for review';
  END IF;
END $$;
DROP INDEX IF EXISTS public.bl_allocations_reservation_226_uq;
COMMIT;
