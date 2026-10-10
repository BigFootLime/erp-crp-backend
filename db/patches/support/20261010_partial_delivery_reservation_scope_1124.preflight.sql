-- Read-only preflight. Refuse incompatible schema or duplicates; no repair DML.
DO $$
BEGIN
  IF to_regclass('public.bon_livraison_ligne_allocations') IS NULL THEN
    RAISE EXCEPTION 'Delivery allocation table is required for #1124';
  END IF;
  IF EXISTS (SELECT 1 FROM public.bon_livraison_ligne_allocations
      WHERE reservation_id IS NOT NULL
      GROUP BY bon_livraison_ligne_id, reservation_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Duplicate line/reservation allocations require review before #1124';
  END IF;
END $$;
