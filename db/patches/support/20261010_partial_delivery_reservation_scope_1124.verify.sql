DO $$
BEGIN
  IF to_regclass('public.bl_allocations_reservation_226_uq') IS NOT NULL THEN
    RAISE EXCEPTION 'Obsolete cross-delivery reservation uniqueness is still present';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_index i
      WHERE i.indexrelid=to_regclass('public.bl_allocations_line_reservation_1124_uq')
        AND i.indrelid='public.bon_livraison_ligne_allocations'::regclass
        AND i.indisunique AND i.indisvalid AND i.indnkeyatts=2
        AND pg_get_indexdef(i.indexrelid,1,true)='bon_livraison_ligne_id'
        AND pg_get_indexdef(i.indexrelid,2,true)='reservation_id'
        AND pg_get_expr(i.indpred,i.indrelid)='(reservation_id IS NOT NULL)') THEN
    RAISE EXCEPTION 'Scoped reservation uniqueness is missing or incompatible';
  END IF;
END $$;
